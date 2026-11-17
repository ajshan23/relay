import type { FileStorage } from "@relay/core";
import { type createDb, fileInUse, recountStorage, releaseStorage, schema, sql } from "@relay/db";

/*
 * Deletes stored files nothing uses any more (their conversations or templates were deleted), once
 * they've been unused for a week. Runs daily on the maintenance queue. The object goes first, then the
 * row, so a failure leaves a row that the next run retries, never an object without a row. Afterwards
 * every business's storage total is recounted from what is really stored.
 * "Used" is fileInUse in @relay/db (attachments, knowledge files, agent pictures, catalogue galleries).
 */

type Db = ReturnType<typeof createDb>["db"];
const BATCH = 200;

export function createFileSweep({ db, storage }: { db: Db; storage: FileStorage }) {
  return async () => {
    const f = schema.storedFile;
    let deleted = 0;
    for (;;) {
      const res = await db.execute(sql`
        select f.id, f.organization_id, f.size_bytes, f.storage_key, f.preview_key
        from ${f} f
        where f.last_used_at < (now() at time zone 'utc') - interval '7 days' and not ${fileInUse}
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
