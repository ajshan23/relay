import type { FileStorage } from "@relay/core";
import { type createDb, recountStorage, releaseStorage, schema, sql } from "@relay/db";

/*
 * Deletes stored files nothing uses any more (their conversations or templates were deleted), once
 * they've been unused for a week. Runs daily on the maintenance queue. The object goes first, then the
 * row, so a failure leaves a row that the next run retries, never an object without a row. Afterwards
 * every business's storage total is recounted from what is really stored.
 *
 * "Used" means something points at the file: a message attachment (chats, templates, automations), a
 * knowledge file, an AI agent's avatar, a catalogue item's gallery. Add any new table that keeps a stored_file id here, or its
 * files will be deleted from under it.
 */

type Db = ReturnType<typeof createDb>["db"];
const BATCH = 200;

export const fileReferences = sql`
  exists (select 1 from ${schema.attachment} a where a.file_id = f.id)
  or exists (select 1 from ${schema.knowledgeSource} k where k.file_id = f.id)
  or exists (select 1 from ${schema.aiAgent} g where g.avatar_file_id = f.id)
  or exists (select 1 from ${schema.catalogMedia} m where m.file_id = f.id)`;

export function createFileSweep({ db, storage }: { db: Db; storage: FileStorage }) {
  return async () => {
    const f = schema.storedFile;
    let deleted = 0;
    for (;;) {
      const res = await db.execute(sql`
        select f.id, f.organization_id, f.size_bytes, f.storage_key, f.preview_key
        from ${f} f
        where f.last_used_at < (now() at time zone 'utc') - interval '7 days' and not (${fileReferences})
        limit ${BATCH}`);
      const orphans = (Array.isArray(res) ? res : []).map((r) => {
        const row = r as Record<string, string | number | null>;
        return {
          id: String(row.id),
          organizationId: String(row.organization_id),
          sizeBytes: Number(row.size_bytes),
          storageKey: String(row.storage_key),
          previewKey: row.preview_key ? String(row.preview_key) : null,
        };
      });
      if (!orphans.length) break;
      for (const o of orphans) {
        await storage.delete(o.storageKey);
        if (o.previewKey) await storage.delete(o.previewKey);
        await db.delete(f).where(sql`${f.id} = ${o.id}`);
        await releaseStorage(db, o.organizationId, o.sizeBytes);
        deleted++;
      }
      if (orphans.length < BATCH) break;
    }
    await recountStorage(db);
    return { deleted };
  };
}
