import { fileStorage, newId } from "@relay/core";
import { catalogImportTargets } from "@relay/core/catalog";
import { and, desc, eq, schema } from "@relay/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { enqueue } from "../../lib/enqueue";
import { can, fail } from "../branches/access";
import { parseBody } from "../branches/routes";
import type { BranchEnv } from "../contacts/shared";

/*
 * Catalogue imports into the selected branch (mounted at /api/catalog/imports):
 *   POST /          multipart { file, typeId }: an Excel or CSV file → the worker reads it
 *   GET  /:id       the sheets (headers, preview, guesses) while mapping; progress after
 *   POST /:id/start { sheet, mapping }: import in the background
 *   GET  /          recent imports
 * Uploaded spreadsheets live under imports/ (deleted by storage after 30 days) and don't count against
 * the business's storage; photo links in them do, as gallery files.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const kinds = ["xlsx", "xls", "csv"] as const;
const targets = new Set<string>(catalogImportTargets.map((t) => t.value));

export function catalogImportRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  const im = schema.catalogImport;
  const storage = fileStorage();
  const canManage = async (c: Context<BranchEnv>) =>
    can(c.var.access, "catalogue.manage", { branchId: c.var.branchId });
  const find = async (c: Context<BranchEnv>, id: string) =>
    (
      await ctx.db
        .select()
        .from(im)
        .where(and(eq(im.id, id), eq(im.organizationId, c.var.access.orgId), eq(im.branchId, c.var.branchId)))
        .limit(1)
    )[0] ?? null;
  const visible = (r: typeof im.$inferSelect) => {
    const { storageKey: _s, organizationId: _o, sheets, ...rest } = r;
    return { ...rest, errors: r.errors.slice(0, 50), sheets: r.status === "mapping" ? sheets : null };
  };

  app.get("/", async (c) => {
    const rows = await ctx.db
      .select()
      .from(im)
      .where(and(eq(im.organizationId, c.var.access.orgId), eq(im.branchId, c.var.branchId)))
      .orderBy(desc(im.createdAt))
      .limit(10);
    return c.json({ imports: rows.map(visible) });
  });

  app.post("/", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    const typeId = String(form?.get("typeId") ?? "");
    if (!(file instanceof File)) return fail(c, 422, "invalid_input", "Choose a file to import.");
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!(kinds as readonly string[]).includes(ext))
      return fail(c, 422, "invalid_input", "Use an Excel (.xlsx, .xls) or CSV file.");
    if (file.size > MAX_BYTES) return fail(c, 422, "too_large", "Files can be up to 20 MB.");
    const [type] = await ctx.db
      .select({ id: schema.catalogType.id })
      .from(schema.catalogType)
      .where(
        and(eq(schema.catalogType.id, typeId), eq(schema.catalogType.organizationId, c.var.access.orgId)),
      );
    if (!type) return fail(c, 422, "invalid_input", "Pick what kind of items these are.");
    const id = newId("catalogImport");
    const storageKey = `imports/${c.var.access.orgId}/${id}.${ext}`;
    await storage.put(storageKey, new Uint8Array(await file.arrayBuffer()));
    const [row] = await ctx.db
      .insert(im)
      .values({
        id,
        organizationId: c.var.access.orgId,
        branchId: c.var.branchId,
        userId: c.var.access.userId,
        typeId: type.id,
        fileName: file.name.slice(0, 200),
        storageKey,
        status: "reading",
      })
      .returning();
    await enqueue(
      ctx.queues.catalog,
      "import-read",
      { importId: id, organizationId: c.var.access.orgId },
      { jobId: `read_${id}`, attempts: 1 },
    );
    return c.json({ import: row && visible(row) }, 201);
  });

  app.get("/:id", async (c) => {
    const row = await find(c, c.req.param("id"));
    return row ? c.json({ import: visible(row) }) : fail(c, 404, "not_found");
  });

  app.post("/:id/start", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({
        sheet: z.string().min(1),
        mapping: z.record(
          z.string(),
          z.string().refine((t) => targets.has(t) || t.startsWith("field:")),
        ),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const row = await find(c, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found");
    if (row.status !== "mapping") return fail(c, 409, "already_started", "This import has already started.");
    const values = Object.values(parsed.data.mapping);
    if (!values.includes("title") && !values.includes("externalId"))
      return fail(c, 422, "invalid_input", "Choose which column has the item's name.");
    const dupes = values.filter((v, i) => v !== "skip" && values.indexOf(v) !== i);
    if (dupes.length) return fail(c, 422, "invalid_input", "Two columns go to the same place. Pick one.");
    await ctx.db
      .update(im)
      .set({ sheet: parsed.data.sheet, mapping: parsed.data.mapping, status: "queued" })
      .where(eq(im.id, row.id));
    await enqueue(
      ctx.queues.catalog,
      "import",
      { importId: row.id, organizationId: c.var.access.orgId },
      { jobId: row.id, attempts: 1 },
    );
    return c.json({ ok: true });
  });

  return app;
}
