import { fileStorage, newId } from "@relay/core";
import {
  type FieldType,
  type ImportMapping,
  type ImportSheet,
  type ImportTarget,
  MAX_IMPORT_OPTIONS,
} from "@relay/core/contacts";
import { writeWorkbook } from "@relay/core/sheets";
import { and, desc, eq, schema } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { enqueue } from "../../lib/enqueue";
import { requireSession } from "../auth/session";
import { fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { activeFields, type BranchEnv, canEditContacts, createField, requireBranch } from "./shared";

/*
 * Importing contacts from Excel (.xlsx, .xls) or CSV. The API never parses spreadsheets itself (a big
 * file is seconds of CPU); the worker reads them.
 *   POST /api/contacts/imports              upload (multipart "file"): stores it; the worker reads it
 *                                           (status "reading", then "mapping" with `sheets`: headers,
 *                                           a preview and a guessed target for every column)
 *   POST /api/contacts/imports/:id/start    { sheet, mapping, onMatch }: creates new fields, then the
 *                                           worker imports the rows in the background
 *   GET  /api/contacts/imports/:id          progress and the first failed rows
 *   GET  /api/contacts/imports/:id/report   the failed rows as a spreadsheet, with why
 */

const MAX_BYTES = 20 * 1024 * 1024;
const kinds = ["xlsx", "xls", "csv"] as const;

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["skip", "name", "phone", "email", "tags", "opt_out"]) }),
  z.object({ kind: z.literal("field"), key: z.string().max(60) }),
  z.object({
    kind: z.literal("new_field"),
    label: z.string().trim().min(1).max(60),
    type: z.enum(["text", "number", "date", "boolean", "select", "multi_select", "email", "phone", "url"]),
  }),
]);

export function contactImportRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx));
  const storage = fileStorage();
  const im = schema.contactImport;

  async function findImport(orgId: string, branchId: string, id: string) {
    const [row] = await ctx.db
      .select()
      .from(im)
      .where(and(eq(im.id, id), eq(im.organizationId, orgId), eq(im.branchId, branchId)))
      .limit(1);
    return row ?? null;
  }

  const publicImport = (r: typeof im.$inferSelect) => {
    const { storageKey: _, organizationId: __, sheets, ...rest } = r;
    return {
      ...rest,
      errors: r.errors.slice(0, 50),
      // The screen shows headers, the preview and guesses; the distinct values stay here.
      sheets:
        r.status === "mapping"
          ? ((sheets ?? []) as ImportSheet[]).map(({ values: _v, parts: _p, ...sh }) => sh)
          : null,
    };
  };

  app.post("/", async (c2) => {
    const access = c2.var.access;
    if (!(await canEditContacts(ctx.db, access, c2.var.branchId))) return fail(c2, 403, "forbidden");
    const form = await c2.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return fail(c2, 422, "invalid_input", "Choose a file to import.");
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!(kinds as readonly string[]).includes(ext))
      return fail(c2, 422, "invalid_input", "Use an Excel (.xlsx, .xls) or CSV file.");
    if (file.size > MAX_BYTES) return fail(c2, 422, "too_large", "Files can be up to 20 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = newId("contactImport");
    // S3 deletes these after 30 days (lifecycle rule on imports/).
    const storageKey = `imports/${access.orgId}/${id}.${ext}`;
    await storage.put(storageKey, bytes);
    const [row] = await ctx.db
      .insert(im)
      .values({
        id,
        organizationId: access.orgId,
        branchId: c2.var.branchId,
        userId: access.userId,
        fileName: file.name,
        storageKey,
        status: "reading",
      })
      .returning();
    await enqueue(ctx.queues.contactFiles, "read", { importId: id }, { jobId: `read_${id}`, attempts: 1 });
    const fields = await activeFields(ctx.db, access.orgId);
    return c2.json(
      {
        import: row && publicImport(row),
        fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type })),
      },
      201,
    );
  });

  app.post("/:id/start", async (c2) => {
    const access = c2.var.access;
    if (!(await canEditContacts(ctx.db, access, c2.var.branchId))) return fail(c2, 403, "forbidden");
    const parsed = await parseBody(
      c2,
      z.object({
        sheet: z.string().max(200),
        mapping: z
          .array(
            z.object({ column: z.number().int().min(0), header: z.string().max(200), target: targetSchema }),
          )
          .max(500),
        onMatch: z.enum(["update", "skip"]).default("update"),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const imp = await findImport(access.orgId, c2.var.branchId, c2.req.param("id"));
    if (!imp) return fail(c2, 404, "not_found");
    if (imp.status !== "mapping") return fail(c2, 409, "already_started", "This import has already started.");
    const b = parsed.data;

    const used = b.mapping.filter((m) => m.target.kind !== "skip");
    for (const k of ["name", "phone", "email", "opt_out"] as const)
      if (used.filter((m) => m.target.kind === k).length > 1)
        return fail(c2, 422, "invalid_input", `Only one column can be the contact's ${k.replace("_", "-")}.`);
    if (!used.some((m) => m.target.kind === "phone" || m.target.kind === "email"))
      return fail(
        c2,
        422,
        "invalid_input",
        "Pick the column with phone numbers or emails, so contacts can be matched.",
      );
    const newFields = used.filter((m) => m.target.kind === "new_field");
    if (newFields.length && !isOrgAdmin(access.orgRole))
      return fail(
        c2,
        403,
        "forbidden",
        "Only owners and admins can add fields. Map those columns to existing fields or skip them.",
      );

    const fields = await activeFields(ctx.db, access.orgId);
    for (const m of used)
      if (m.target.kind === "field" && !fields.some((f) => f.key === (m.target as { key: string }).key))
        return fail(c2, 422, "invalid_input", `Column "${m.header}" points at a field that doesn't exist.`);

    // New choice fields get their options from the column's values, which the worker collected.
    const sheet = ((imp.sheets ?? []) as ImportSheet[]).find((s) => s.name === b.sheet);
    if (!sheet) return fail(c2, 422, "invalid_input", "That sheet isn't in the file.");
    const mapping: ImportMapping = [];
    for (const m of b.mapping) {
      if (m.target.kind !== "new_field") {
        mapping.push(m as ImportMapping[number]);
        continue;
      }
      const t = m.target as { label: string; type: FieldType };
      let options: { label: string }[] | undefined;
      if (t.type === "select" || t.type === "multi_select") {
        const values = (t.type === "multi_select" ? sheet.parts : sheet.values)[m.column] ?? [];
        if (values.length > MAX_IMPORT_OPTIONS)
          return fail(
            c2,
            422,
            "invalid_input",
            `"${m.header}" has more than ${MAX_IMPORT_OPTIONS} different values. Import it as text.`,
          );
        options = values.map((label) => ({ label }));
      }
      const field = await createField(ctx.db, access.orgId, access.userId, {
        label: t.label,
        type: t.type,
        options,
      });
      mapping.push({
        column: m.column,
        header: m.header,
        target: { kind: "field", key: field.key } satisfies ImportTarget,
      });
    }

    const [row] = await ctx.db
      .update(im)
      .set({
        sheet: b.sheet,
        mapping: mapping as never,
        onMatch: b.onMatch,
        status: "queued",
        total: sheet.total,
      })
      .where(eq(im.id, imp.id))
      .returning();
    await enqueue(ctx.queues.contacts, "import", { importId: imp.id }, { jobId: imp.id, attempts: 1 });
    return c2.json({ import: row && publicImport(row) });
  });

  app.get("/", async (c2) => {
    const access = c2.var.access;
    const rows = await ctx.db
      .select()
      .from(im)
      .where(and(eq(im.organizationId, access.orgId), eq(im.branchId, c2.var.branchId)))
      .orderBy(desc(im.createdAt))
      .limit(10);
    return c2.json({ imports: rows.map(publicImport) });
  });

  app.get("/:id", async (c2) => {
    const imp = await findImport(c2.var.access.orgId, c2.var.branchId, c2.req.param("id"));
    if (!imp) return fail(c2, 404, "not_found");
    return c2.json({ import: publicImport(imp) });
  });

  app.get("/:id/report", async (c2) => {
    const imp = await findImport(c2.var.access.orgId, c2.var.branchId, c2.req.param("id"));
    if (!imp) return fail(c2, 404, "not_found");
    const headers = [
      "Row",
      "Why it was not imported",
      ...((imp.mapping as ImportMapping | null) ?? []).map((m) => m.header),
    ];
    const rows = imp.errors.map((e) => [e.row, e.reason, ...(e.values ?? [])]);
    const bytes = writeWorkbook(headers, rows, "xlsx");
    return c2.body(bytes as unknown as ArrayBuffer, 200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="import-problems-${imp.id}.xlsx"`,
    });
  });

  return app;
}
