import { env, localFileStorage, newId } from "@relay/core";
import {
  type ContactFieldDef,
  coerceFieldValue,
  type ImportMapping,
  isYes,
  optionColours,
} from "@relay/core/contacts";
import { readWorkbook } from "@relay/core/sheets";
import { and, type createDb, eq, inArray, isNull, or, schema, sql } from "@relay/db";
import type { Job } from "bullmq";

/*
 * Imports the rows of an uploaded spreadsheet in batches of BATCH rows: each batch looks up its phone
 * numbers and emails at once and writes with one insert and one update, so 100,000 rows take a few
 * hundred queries, not half a million. Rows are still applied in file order, so a phone number
 * repeated in the file lands on one contact. Existing contacts are matched by phone (their own or any
 * channel's), then by email; empty cells never clear what's already there. Rows that can't be imported
 * are kept with why.
 */

type Db = ReturnType<typeof createDb>["db"];
export type ImportJob = { importId: string };

const BATCH = 500;
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

      // Every tag named anywhere in the file, created up front (one insert) if new.
      const tagColumn = mapping.find((m) => m.target.kind === "tags")?.column;
      const splitTags = (cell: unknown) =>
        String(cell ?? "")
          .split(/[,;]/)
          .map((n) => n.trim().slice(0, 60))
          .filter(Boolean);
      if (tagColumn !== undefined) {
        const missing = new Map<string, string>();
        for (const row of sheet.rows)
          for (const name of splitTags(row[tagColumn]))
            if (!tags.has(name.toLowerCase())) missing.set(name.toLowerCase(), name);
        if (missing.size) {
          await db
            .insert(schema.tag)
            .values(
              [...missing.values()].map((name, i) => ({
                id: newId("tag"),
                organizationId: orgId,
                name,
                colour: optionColours[(tags.size + i) % optionColours.length] ?? "gray",
                createdByUserId: imp.userId,
              })),
            )
            .onConflictDoNothing();
          const made = await db
            .select({ id: schema.tag.id, name: schema.tag.name })
            .from(schema.tag)
            .where(
              and(
                eq(schema.tag.organizationId, orgId),
                isNull(schema.tag.branchId),
                isNull(schema.tag.channelAccountId),
                inArray(sql`lower(${schema.tag.name})`, [...missing.keys()]),
              ),
            );
          for (const t of made) tags.set(t.name.trim().toLowerCase(), t.id);
        }
      }

      type Parsed = {
        name: string | null;
        phone: string | null;
        email: string | null;
        tagIds: string[];
        optOut: boolean;
        attributes: Record<string, unknown>;
      };

      /** One row's values, checked. Throws RowError. */
      function parseRow(row: unknown[]): Parsed {
        const out: Parsed = {
          name: null,
          phone: null,
          email: null,
          tagIds: [],
          optOut: false,
          attributes: {},
        };
        for (const m of mapping) {
          const cell = row[m.column];
          if (cell === null || cell === undefined || String(cell).trim() === "") continue;
          const t = m.target;
          switch (t.kind) {
            case "name":
              out.name = String(cell).trim().slice(0, 120);
              break;
            case "phone": {
              const digits = String(cell).replace(/[^\d]/g, "");
              if (digits.length < 6 || digits.length > 16)
                throw new RowError(`${m.header}: "${cell}" isn't a phone number with country code.`);
              out.phone = digits;
              break;
            }
            case "email": {
              const e = String(cell).trim().toLowerCase();
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
                throw new RowError(`${m.header}: "${cell}" isn't an email address.`);
              out.email = e;
              break;
            }
            case "tags":
              out.tagIds = [
                ...new Set(
                  splitTags(cell)
                    .map((n) => tags.get(n.toLowerCase()))
                    .filter((id): id is string => !!id),
                ),
              ];
              break;
            case "opt_out":
              out.optOut = isYes(cell);
              break;
            case "field": {
              const field = fields.get(t.key);
              if (!field) break;
              const r = coerceFieldValue(field, cell);
              if (!r.ok) throw new RowError(r.message);
              if (r.value !== null) out.attributes[t.key] = r.value;
              break;
            }
          }
        }
        if (!out.phone && !out.email) throw new RowError("No phone number or email to match the contact by.");
        return out;
      }

      // Contacts this import already created or matched, by phone and email, across batches.
      const byPhone = new Map<string, string>();
      const byEmail = new Map<string, string>();

      /** Looks up the batch's phone numbers and emails in the branch, in two queries. */
      async function preload(batch: Parsed[]) {
        const phones = [...new Set(batch.map((p) => p.phone).filter((v): v is string => !!v))].filter(
          (p) => !byPhone.has(p),
        );
        const emails = [...new Set(batch.map((p) => p.email).filter((v): v is string => !!v))].filter(
          (e) => !byEmail.has(e),
        );
        if (phones.length || emails.length) {
          const hits = await db
            .select({ id: c.id, phone: c.phone, email: c.email })
            .from(c)
            .where(
              and(
                eq(c.organizationId, orgId),
                eq(c.branchId, imp.branchId),
                or(
                  phones.length ? inArray(c.phone, phones) : undefined,
                  emails.length ? inArray(c.email, emails) : undefined,
                ),
              ),
            );
          for (const h of hits) {
            if (h.phone && phones.includes(h.phone) && !byPhone.has(h.phone)) byPhone.set(h.phone, h.id);
            if (h.email && emails.includes(h.email) && !byEmail.has(h.email)) byEmail.set(h.email, h.id);
          }
        }
        const unmatched = phones.filter((p) => !byPhone.has(p));
        if (unmatched.length) {
          const ident = schema.contactIdentity;
          const hits = await db
            .select({ id: ident.contactId, phone: ident.phone })
            .from(ident)
            .where(and(eq(ident.branchId, imp.branchId), inArray(ident.phone, unmatched)));
          for (const h of hits) if (h.phone && !byPhone.has(h.phone)) byPhone.set(h.phone, h.id);
        }
      }

      async function importBatch(batch: { index: number; row: unknown[] }[]) {
        const parsed: { index: number; row: unknown[]; p: Parsed }[] = [];
        for (const { index, row } of batch) {
          try {
            parsed.push({ index, row, p: parseRow(row) });
          } catch (err) {
            if (!(err instanceof RowError)) throw err;
            counts.failed++;
            // Row numbers as people see them in the spreadsheet: the header is row 1.
            if (errors.length < MAX_ERRORS) errors.push({ row: index + 2, reason: err.message, values: row });
          }
        }
        await preload(parsed.map((x) => x.p));

        const inserts = new Map<string, typeof c.$inferInsert>();
        const updates = new Map<string, Parsed>();
        const optOuts = new Set<string>();
        for (const { p } of parsed) {
          const existing = (p.phone && byPhone.get(p.phone)) || (p.email && byEmail.get(p.email)) || null;
          let contactId: string;
          if (existing) {
            if (imp.onMatch === "skip") {
              counts.skipped++;
              continue;
            }
            contactId = existing;
            const pending = inserts.get(existing);
            if (pending) {
              // Created earlier in this batch: fold this row into it.
              if (p.name) pending.name = p.name;
              if (p.phone) pending.phone = p.phone;
              if (p.email) pending.email = p.email;
              pending.tagIds = [...new Set([...(pending.tagIds ?? []), ...p.tagIds])];
              pending.attributes = { ...(pending.attributes ?? {}), ...p.attributes };
            } else {
              const prev = updates.get(existing);
              updates.set(
                existing,
                prev
                  ? {
                      name: p.name ?? prev.name,
                      phone: p.phone ?? prev.phone,
                      email: p.email ?? prev.email,
                      tagIds: [...new Set([...prev.tagIds, ...p.tagIds])],
                      optOut: prev.optOut || p.optOut,
                      attributes: { ...prev.attributes, ...p.attributes },
                    }
                  : p,
              );
            }
            counts.updated++;
          } else {
            contactId = newId("contact");
            inserts.set(contactId, {
              id: contactId,
              organizationId: orgId,
              name: p.name,
              phone: p.phone,
              email: p.email,
              branchId: imp.branchId,
              tagIds: p.tagIds,
              attributes: p.attributes,
              source: "import",
              createdByUserId: imp.userId,
            });
            counts.created++;
          }
          if (p.phone && !byPhone.has(p.phone)) byPhone.set(p.phone, contactId);
          if (p.email && !byEmail.has(p.email)) byEmail.set(p.email, contactId);
          if (p.optOut) optOuts.add(contactId);
        }

        await db.transaction(async (tx) => {
          if (inserts.size) await tx.insert(c).values([...inserts.values()]);
          if (updates.size) {
            const values = [...updates].map(([id, p]) => ({
              id,
              name: p.name,
              phone: p.phone,
              email: p.email,
              tags: p.tagIds.length ? p.tagIds : null,
              attrs: p.attributes,
            }));
            // One statement for the whole batch; empty cells (nulls) keep what's there.
            await tx.execute(sql`
              update contact set
                name = coalesce(v.name, contact.name),
                phone = coalesce(v.phone, contact.phone),
                email = coalesce(v.email, contact.email),
                tag_ids = case when v.tags is null then contact.tag_ids
                  else array(select distinct unnest(contact.tag_ids || v.tags)) end,
                attributes = contact.attributes || v.attrs,
                updated_at = now()
              from jsonb_to_recordset(${JSON.stringify(values)}::jsonb)
                as v(id text, name text, phone text, email text, tags text[], attrs jsonb)
              where contact.id = v.id`);
          }
          if (optOuts.size)
            await tx
              .insert(schema.contactOptOut)
              .values(
                [...optOuts].map((contactId) => ({
                  id: newId("contactOptOut"),
                  organizationId: orgId,
                  contactId,
                  channelAccountId: null,
                  source: "import" as const,
                  createdByUserId: imp.userId,
                })),
              )
              .onConflictDoNothing();
        });
        counts.processed += batch.length;
      }

      for (let start = 0; start < sheet.rows.length; start += BATCH) {
        await importBatch(
          sheet.rows.slice(start, start + BATCH).map((row, i) => ({ index: start + i, row })),
        );
        await save();
      }
      await save({ status: "done", finishedAt: new Date() });
    } catch (err) {
      console.error(`contact import ${imp.id} failed`, err);
      errors.unshift({ row: 0, reason: "The import stopped unexpectedly. Rows before this were imported." });
      await save({ status: "failed", finishedAt: new Date() });
    }
  };
}
