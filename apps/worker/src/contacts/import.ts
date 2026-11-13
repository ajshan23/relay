import { env, localFileStorage, newId } from "@relay/core";
import {
  type ContactFieldDef,
  coerceFieldValue,
  type ImportMapping,
  isYes,
  optionColours,
} from "@relay/core/contacts";
import { readWorkbook } from "@relay/core/sheets";
import { and, type createDb, eq, isNull, schema, sql } from "@relay/db";
import type { Job } from "bullmq";

/*
 * Imports the rows of an uploaded spreadsheet, one at a time so a phone number repeated in the file
 * lands on one contact. Existing contacts are matched by phone (their own or any channel's), then by
 * email; empty cells never clear what's already there. Rows that can't be imported are kept with why.
 */

type Db = ReturnType<typeof createDb>["db"];
export type ImportJob = { importId: string };

const PROGRESS_EVERY = 100;
const MAX_ERRORS = 1000;

class RowError extends Error {}

export function createImportProcessor({ db }: { db: Db }) {
  const storage = localFileStorage(env().MEDIA_DIR);
  const im = schema.contactImport;
  const c = schema.contact;

  return async (job: Job<ImportJob>) => {
    const [found] = await db.select().from(im).where(eq(im.id, job.data.importId)).limit(1);
    if (found?.status !== "queued") return;
    const imp = found;
    const orgId = imp.organizationId;
    await db.update(im).set({ status: "running" }).where(eq(im.id, imp.id));

    const counts = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
    const errors: { row: number; reason: string; values?: unknown[] }[] = [];
    const save = (extra: Partial<typeof im.$inferInsert> = {}) =>
      db
        .update(im)
        .set({ ...counts, errors, ...extra })
        .where(eq(im.id, imp.id));

    try {
      const sheet = readWorkbook(await storage.get(imp.storageKey)).find((s) => s.name === imp.sheet);
      if (!sheet) throw new Error("The sheet is missing from the file.");
      const mapping = (imp.mapping as ImportMapping | null) ?? [];

      const fields = new Map(
        (
          await db
            .select()
            .from(schema.contactField)
            .where(and(eq(schema.contactField.organizationId, orgId), isNull(schema.contactField.archivedAt)))
        ).map((f) => [f.key, f as unknown as ContactFieldDef]),
      );
      const branches = new Map(
        (
          await db
            .select({ id: schema.branch.id, name: schema.branch.name })
            .from(schema.branch)
            .where(eq(schema.branch.organizationId, orgId))
        ).map((b) => [b.name.trim().toLowerCase(), b.id]),
      );
      // Tags made by an import are for the whole business.
      const tags = new Map(
        (
          await db
            .select({ id: schema.tag.id, name: schema.tag.name })
            .from(schema.tag)
            .where(
              and(
                eq(schema.tag.organizationId, orgId),
                isNull(schema.tag.branchId),
                isNull(schema.tag.channelAccountId),
              ),
            )
        ).map((t) => [t.name.trim().toLowerCase(), t.id]),
      );

      async function tagIds(cell: unknown) {
        const names = String(cell ?? "")
          .split(/[,;]/)
          .map((n) => n.trim())
          .filter(Boolean);
        const ids: string[] = [];
        for (const name of names) {
          let id = tags.get(name.toLowerCase());
          if (!id) {
            await db
              .insert(schema.tag)
              .values({
                id: newId("tag"),
                organizationId: orgId,
                name: name.slice(0, 60),
                colour: optionColours[tags.size % optionColours.length] ?? "gray",
                createdByUserId: imp.userId,
              })
              .onConflictDoNothing();
            const [row] = await db
              .select({ id: schema.tag.id })
              .from(schema.tag)
              .where(
                and(
                  eq(schema.tag.organizationId, orgId),
                  sql`lower(${schema.tag.name}) = lower(${name.slice(0, 60)})`,
                  isNull(schema.tag.branchId),
                  isNull(schema.tag.channelAccountId),
                ),
              )
              .limit(1);
            if (!row) continue;
            id = row.id;
            tags.set(name.toLowerCase(), id);
          }
          if (!ids.includes(id)) ids.push(id);
        }
        return ids;
      }

      async function importRow(row: unknown[]) {
        let name: string | null = null;
        let phone: string | null = null;
        let email: string | null = null;
        let branchId: string | null = null;
        let addTags: string[] = [];
        let optOut = false;
        const attributes: Record<string, unknown> = {};

        for (const m of mapping) {
          const cell = row[m.column];
          if (cell === null || cell === undefined || String(cell).trim() === "") continue;
          const t = m.target;
          switch (t.kind) {
            case "name":
              name = String(cell).trim().slice(0, 120);
              break;
            case "phone": {
              const digits = String(cell).replace(/[^\d]/g, "");
              if (digits.length < 6 || digits.length > 16)
                throw new RowError(`${m.header}: "${cell}" isn't a phone number with country code.`);
              phone = digits;
              break;
            }
            case "email": {
              const e = String(cell).trim().toLowerCase();
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
                throw new RowError(`${m.header}: "${cell}" isn't an email address.`);
              email = e;
              break;
            }
            case "branch": {
              const id = branches.get(String(cell).trim().toLowerCase());
              if (!id) throw new RowError(`${m.header}: there's no branch called "${cell}".`);
              branchId = id;
              break;
            }
            case "tags":
              addTags = await tagIds(cell);
              break;
            case "opt_out":
              optOut = isYes(cell);
              break;
            case "field": {
              const field = fields.get(t.key);
              if (!field) break;
              const r = coerceFieldValue(field, cell);
              if (!r.ok) throw new RowError(r.message);
              if (r.value !== null) attributes[t.key] = r.value;
              break;
            }
          }
        }
        if (!phone && !email) throw new RowError("No phone number or email to match the contact by.");

        let existingId: string | null = null;
        if (phone) {
          const [hit] = await db
            .select({ id: c.id })
            .from(c)
            .where(
              and(
                eq(c.organizationId, orgId),
                sql`(${c.phone} = ${phone} or exists (select 1 from ${schema.contactIdentity} i where i.contact_id = ${c.id} and i.phone = ${phone}))`,
              ),
            )
            .limit(1);
          existingId = hit?.id ?? null;
        }
        if (!existingId && email) {
          const [hit] = await db
            .select({ id: c.id })
            .from(c)
            .where(and(eq(c.organizationId, orgId), eq(c.email, email)))
            .limit(1);
          existingId = hit?.id ?? null;
        }

        let contactId: string;
        if (existingId) {
          if (imp.onMatch === "skip") {
            counts.skipped++;
            return;
          }
          const tagArr = addTags.length
            ? sql`array[${sql.join(
                addTags.map((t) => sql`${t}`),
                sql`, `,
              )}]::text[]`
            : null;
          await db
            .update(c)
            .set({
              ...(name ? { name } : {}),
              ...(phone ? { phone } : {}),
              ...(email ? { email } : {}),
              ...(branchId ? { branchId } : {}),
              ...(tagArr ? { tagIds: sql`array(select distinct unnest(${c.tagIds} || ${tagArr}))` } : {}),
              ...(Object.keys(attributes).length
                ? { attributes: sql`${c.attributes} || ${JSON.stringify(attributes)}::jsonb` }
                : {}),
              updatedAt: new Date(),
            } as never)
            .where(eq(c.id, existingId));
          contactId = existingId;
          counts.updated++;
        } else {
          contactId = newId("contact");
          await db.insert(c).values({
            id: contactId,
            organizationId: orgId,
            name,
            phone,
            email,
            branchId,
            tagIds: addTags,
            attributes,
            source: "import",
            createdByUserId: imp.userId,
          });
          counts.created++;
        }
        if (optOut)
          await db
            .insert(schema.contactOptOut)
            .values({
              id: newId("contactOptOut"),
              organizationId: orgId,
              contactId,
              channelAccountId: null,
              source: "import",
              createdByUserId: imp.userId,
            })
            .onConflictDoNothing();
      }

      for (const [i, row] of sheet.rows.entries()) {
        try {
          await importRow(row);
        } catch (err) {
          if (!(err instanceof RowError)) throw err;
          counts.failed++;
          // Row numbers as people see them in the spreadsheet: the header is row 1.
          if (errors.length < MAX_ERRORS) errors.push({ row: i + 2, reason: err.message, values: row });
        }
        counts.processed++;
        if (counts.processed % PROGRESS_EVERY === 0) await save();
      }
      await save({ status: "done", finishedAt: new Date() });
    } catch (err) {
      console.error(`contact import ${imp.id} failed`, err);
      errors.unshift({ row: 0, reason: "The import stopped unexpectedly. Rows before this were imported." });
      await save({ status: "failed", finishedAt: new Date() });
    }
  };
}
