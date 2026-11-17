import { type FileStorage, newId } from "@relay/core";
import {
  type CatalogImportTarget,
  type CatalogItemInput,
  catalogMediaKind,
  catalogMediaLimits,
  summarizeCatalogSheet,
} from "@relay/core/catalog";
import { readWorkbook } from "@relay/core/sheets";
import {
  and,
  CatalogInputError,
  type createDb,
  eq,
  inArray,
  loadCatalogType,
  releaseStorage,
  reserveStorage,
  StorageFullError,
  saveCatalogItem,
  schema,
  sql,
  toFieldDef,
} from "@relay/db";
import type { Job, Queue } from "bullmq";
import { fetchPublicFile } from "../agent/extract";

/*
 * Catalogue imports from Excel or CSV (queue "catalog"):
 *   "import-read"  reads the file: every sheet's headers, a preview and a guess per column → mapping
 *   "import"       imports the chosen sheet in batches with progress. Rows with the same id (or, with
 *                  no id column, the same name) are one item, each row one of its options. Importing
 *                  again updates the items it made. Photo links are downloaded (public addresses only)
 *                  and prepared like uploads, within the business's storage.
 * One import at a time per business (see index.ts), so a 50,000-row file doesn't hold up anyone else.
 */

type Db = ReturnType<typeof createDb>["db"];
export type ImportJob = { importId: string; organizationId: string };

const GROUPS_PER_BATCH = 200;
const MAX_ERRORS = 1000;
const MAX_PHOTOS_PER_ITEM = 5;

const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export function createCatalogImporter(deps: {
  db: Db;
  storage: FileStorage;
  media: Queue | null;
  embedSoon: (organizationId: string, branchId: string) => Promise<unknown>;
}) {
  const { db, storage } = deps;
  const im = schema.catalogImport;

  async function read(job: Job<ImportJob>) {
    const [imp] = await db.select().from(im).where(eq(im.id, job.data.importId)).limit(1);
    if (imp?.status !== "reading") return;
    const fail = (readError: string) =>
      db.update(im).set({ status: "failed", readError, finishedAt: new Date() }).where(eq(im.id, imp.id));
    let sheets: ReturnType<typeof readWorkbook>;
    try {
      sheets = readWorkbook(await storage.get(imp.storageKey)).filter((s) => s.headers.length);
    } catch {
      await fail("We couldn't read that file. Save it as .xlsx or .csv and try again.");
      return;
    }
    if (!sheets.length) {
      await fail("That file has no rows to import.");
      return;
    }
    const loaded = imp.typeId ? await loadCatalogType(db, imp.organizationId, imp.typeId) : null;
    const fields = (loaded?.fields ?? []).map(toFieldDef);
    await db
      .update(im)
      .set({ status: "mapping", sheets: sheets.map((s) => summarizeCatalogSheet(s, fields)) })
      .where(eq(im.id, imp.id));
  }

  async function run(job: Job<ImportJob>) {
    const [imp] = await db.select().from(im).where(eq(im.id, job.data.importId)).limit(1);
    if (imp?.status !== "queued" || !imp.typeId) return;
    await db.update(im).set({ status: "running" }).where(eq(im.id, imp.id));
    const orgId = imp.organizationId;
    const branchId = imp.branchId;
    const errors: { row: number; reason: string }[] = [];
    const counts = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
    const note = (row: number, reason: string) => {
      if (errors.length < MAX_ERRORS) errors.push({ row, reason });
    };
    try {
      const sheet = readWorkbook(await storage.get(imp.storageKey)).find((s) => s.name === imp.sheet);
      if (!sheet) throw new Error("That sheet isn't in the file any more.");
      const mapping = (imp.mapping ?? {}) as Record<string, CatalogImportTarget>;
      const col = (target: CatalogImportTarget) => sheet.headers.findIndex((h) => mapping[h] === target);
      const at = (row: unknown[], target: CatalogImportTarget) => {
        const i = col(target);
        return i < 0 ? "" : cell(row[i]);
      };
      const loaded = await loadCatalogType(db, orgId, imp.typeId);
      if (!loaded) throw new Error("The type for this import was removed.");
      const fields = loaded.fields.map(toFieldDef);
      const [settings] = await db
        .select({ catalog: schema.organizationSettings.catalog })
        .from(schema.organizationSettings)
        .where(eq(schema.organizationSettings.organizationId, orgId));
      const defaultCurrency = settings?.catalog?.currency ?? "AED";

      // Group rows into items.
      const groups = new Map<string, { rows: { row: unknown[]; index: number }[] }>();
      sheet.rows.forEach((row, index) => {
        const title = at(row, "title");
        const id = at(row, "externalId");
        if (!title && !id) {
          counts.skipped++;
          return;
        }
        const key = id || `name:${title.toLowerCase()}`;
        const g = groups.get(key) ?? { rows: [] };
        g.rows.push({ row, index });
        groups.set(key, g);
      });
      await db.update(im).set({ total: sheet.rows.length }).where(eq(im.id, imp.id));

      const categoryIds = await categoryResolver(orgId, branchId);
      const entries = [...groups.entries()];
      for (let start = 0; start < entries.length; start += GROUPS_PER_BATCH) {
        const batch = entries.slice(start, start + GROUPS_PER_BATCH);
        const existing = await db
          .select({ id: schema.catalogItem.id, externalId: schema.catalogItem.externalId })
          .from(schema.catalogItem)
          .where(
            and(
              eq(schema.catalogItem.organizationId, orgId),
              eq(schema.catalogItem.branchId, branchId),
              eq(schema.catalogItem.source, "import"),
              inArray(
                schema.catalogItem.externalId,
                batch.map(([k]) => k),
              ),
            ),
          );
        const existingBy = new Map(existing.map((e) => [e.externalId, e.id]));
        for (const [key, group] of batch) {
          const first = group.rows[0];
          if (!first) continue;
          const rowNo = first.index + 2; // header is row 1
          try {
            const attributes: Record<string, unknown> = {};
            for (const f of fields.filter((x) => !x.onVariant)) {
              const v = at(first.row, `field:${f.key}`);
              if (v) attributes[f.key] = v;
            }
            const itemId = existingBy.get(key);
            const oldVariants = itemId
              ? await db
                  .select({
                    id: schema.catalogVariant.id,
                    title: schema.catalogVariant.title,
                    sku: schema.catalogVariant.sku,
                  })
                  .from(schema.catalogVariant)
                  .where(eq(schema.catalogVariant.itemId, itemId))
              : [];
            const used = new Set<string>();
            const variants: CatalogItemInput["variants"] = group.rows.map(({ row }) => {
              const options: Record<string, unknown> = {};
              for (const f of fields.filter((x) => x.onVariant)) {
                const v = at(row, `field:${f.key}`);
                if (v) options[f.key] = v;
              }
              // Without an option column, an option is named by its option fields ("M", "Grey / L").
              const title =
                at(row, "option") ||
                fields
                  .filter((x) => x.onVariant)
                  .map((x) => at(row, `field:${x.key}`))
                  .filter(Boolean)
                  .join(" / ");
              const sku = at(row, "sku") || null;
              const old = oldVariants.find(
                (o) => !used.has(o.id) && ((sku && o.sku === sku) || (!sku && o.title === title)),
              );
              if (old) used.add(old.id);
              const stock = at(row, "stock");
              const duration = at(row, "duration");
              return {
                id: old?.id,
                title,
                sku,
                price: at(row, "price") || null,
                salePrice: at(row, "salePrice") || null,
                currency: (at(row, "currency") || defaultCurrency).toUpperCase(),
                options,
                stock: stock ? Math.max(0, Math.round(Number(stock.replace(/[, ]/g, "")))) || 0 : null,
                available: true,
                durationMinutes: duration ? Math.round(Number(duration)) || null : null,
                bookable: loaded.type.kind === "service",
              };
            });
            const status = at(first.row, "status").toLowerCase();
            const categoryPath = at(first.row, "category");
            const item = await saveCatalogItem(db, {
              organizationId: orgId,
              branchId,
              userId: imp.userId,
              itemId,
              source: "import",
              externalId: key,
              input: {
                typeId: imp.typeId,
                categoryId: categoryPath ? await categoryIds(categoryPath) : null,
                title: at(first.row, "title") || key.replace(/^name:/, ""),
                description: group.rows.map(({ row }) => at(row, "description")).find(Boolean) ?? "",
                attributes,
                status: /draft/.test(status)
                  ? "draft"
                  : /archiv|hidden|inactive/.test(status)
                    ? "archived"
                    : "active",
                tags: at(first.row, "tags")
                  .split(/[,;]/)
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .slice(0, 20),
                variants,
              },
              newId: (k) => newId(k),
            });
            if (itemId) counts.updated++;
            else counts.created++;
            const links = at(first.row, "images")
              .split(/[\s,]+/)
              .filter((u) => /^https?:\/\//i.test(u))
              .slice(0, MAX_PHOTOS_PER_ITEM);
            if (links.length && !itemId) await importPhotos(orgId, branchId, item.id, links, rowNo, note);
          } catch (err) {
            counts.failed++;
            note(rowNo, err instanceof CatalogInputError ? err.message : "This row couldn't be imported.");
            if (!(err instanceof CatalogInputError))
              console.warn(`catalog import ${imp.id} row ${rowNo}:`, err);
          }
          counts.processed += group.rows.length;
        }
        await db
          .update(im)
          .set({ ...counts, errors })
          .where(eq(im.id, imp.id));
      }
      await db
        .update(im)
        .set({ ...counts, errors, status: "done", finishedAt: new Date() })
        .where(eq(im.id, imp.id));
      await deps.embedSoon(orgId, branchId);
    } catch (err) {
      await db
        .update(im)
        .set({
          ...counts,
          errors,
          status: "failed",
          readError: (err as Error).message.slice(0, 300),
          finishedAt: new Date(),
        })
        .where(eq(im.id, imp.id));
    }
  }

  /** Category ids by path ("Living > Sofas"), creating any that are missing. */
  async function categoryResolver(orgId: string, branchId: string) {
    const C = schema.catalogCategory;
    const all = await db
      .select()
      .from(C)
      .where(and(eq(C.organizationId, orgId), eq(C.branchId, branchId)));
    return async (path: string) => {
      let parentId: string | null = null;
      for (const raw of path.split(/\s*[>›/|]\s*/)) {
        const name = raw.trim().slice(0, 60);
        if (!name) continue;
        const under: string | null = parentId;
        let found: typeof C.$inferSelect | undefined = all.find(
          (c) => c.parentId === under && c.name.toLowerCase() === name.toLowerCase(),
        );
        if (!found) {
          const made: (typeof C.$inferSelect)[] = await db
            .insert(C)
            .values({ id: newId("catalogCategory"), organizationId: orgId, branchId, name, parentId: under })
            .returning();
          found = made[0];
          if (!found) break;
          all.push(found);
        }
        parentId = found.id;
      }
      return parentId;
    };
  }

  async function importPhotos(
    orgId: string,
    branchId: string,
    itemId: string,
    links: string[],
    rowNo: number,
    note: (row: number, reason: string) => void,
  ) {
    for (const [i, link] of links.entries()) {
      let got: { bytes: Uint8Array; contentType: string };
      try {
        got = await fetchPublicFile(link, catalogMediaLimits.uploadMaxBytes.video);
      } catch (err) {
        note(rowNo, `Photo ${i + 1}: ${(err as Error).message}`);
        continue;
      }
      const kind = catalogMediaKind(got.contentType);
      const max = kind ? catalogMediaLimits.uploadMaxBytes[kind] : 0;
      if (!kind || got.bytes.byteLength > max) {
        note(rowNo, `Photo ${i + 1}: that link isn't a photo, video or PDF we can use.`);
        continue;
      }
      try {
        await reserveStorage(db, orgId, got.bytes.byteLength, "enforce");
      } catch (err) {
        if (err instanceof StorageFullError) {
          note(rowNo, "Photos skipped: your storage is full.");
          return;
        }
        throw err;
      }
      const id = newId("catalogMedia");
      const uploadKey = `uploads/${orgId}/${id}`;
      try {
        await storage.put(uploadKey, got.bytes, { contentType: got.contentType });
        const [{ primaries } = { primaries: 0 }] = await db
          .select({ primaries: sql<number>`count(*)::int` })
          .from(schema.catalogMedia)
          .where(and(eq(schema.catalogMedia.itemId, itemId), eq(schema.catalogMedia.isPrimary, true)));
        await db.insert(schema.catalogMedia).values({
          id,
          organizationId: orgId,
          branchId,
          itemId,
          kind,
          mimeType: got.contentType,
          fileName: decodeURIComponent(new URL(link).pathname.split("/").pop() || `photo-${i + 1}`).slice(
            0,
            200,
          ),
          sizeBytes: got.bytes.byteLength,
          reservedBytes: got.bytes.byteLength,
          uploadKey,
          position: i,
          isPrimary: primaries === 0 && (kind === "image" || kind === "video"),
        });
        await deps.media?.add("prepare", { mediaId: id }, { jobId: id, attempts: 2 });
      } catch (err) {
        await releaseStorage(db, orgId, got.bytes.byteLength);
        note(rowNo, `Photo ${i + 1}: couldn't be saved.`);
        console.warn("catalog import photo", err);
      }
    }
  }

  return { read, run };
}
