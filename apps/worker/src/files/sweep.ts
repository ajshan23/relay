import type { FileStorage } from "@relay/core";
import { type createDb, schema, sql } from "@relay/db";

/*
 * Deletes stored files nothing uses any more (their conversations or templates were deleted), once
 * they've been unused for a week. Runs daily on the maintenance queue. The object goes first, then the
 * row, so a failure leaves a row that the next run retries, never an object without a row.
 */

type Db = ReturnType<typeof createDb>["db"];
const BATCH = 200;

export function createFileSweep({ db, storage }: { db: Db; storage: FileStorage }) {
  return async () => {
    const f = schema.storedFile;
    let deleted = 0;
    for (;;) {
      const orphans = await db
        .select({ id: f.id, storageKey: f.storageKey })
        .from(f)
        .where(
          sql`${f.lastUsedAt} < (now() at time zone 'utc') - interval '7 days'
            and not exists (select 1 from ${schema.attachment} a where a.file_id = ${f.id})`,
        )
        .limit(BATCH);
      if (!orphans.length) break;
      for (const o of orphans) {
        await storage.delete(o.storageKey);
        await db.delete(f).where(sql`${f.id} = ${o.id}`);
        deleted++;
      }
      if (orphans.length < BATCH) break;
    }
    return { deleted };
  };
}
