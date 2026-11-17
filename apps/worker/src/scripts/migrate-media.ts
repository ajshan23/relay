import { env, fileStorage, localFileStorage, newId } from "@relay/core";
import { createDb, schema, sql, storeFile } from "@relay/db";

/*
 * Moves files from the local disk (MEDIA_DIR) into the current storage (S3 when S3_BUCKET is set),
 * one copy per business: attachments get a stored_file each (duplicates merge), and spreadsheets
 * waiting to be imported are copied over. Safe to run again: done attachments are skipped.
 * Run: pnpm --filter @relay/worker media:migrate
 */

const config = env();
const { db, sql: client } = createDb(config.DATABASE_URL);
const from = localFileStorage(config.MEDIA_DIR);
const to = fileStorage();
console.log(
  `Moving files from ${config.MEDIA_DIR} to ${to.driver}${to.driver === "s3" ? ` (${config.S3_BUCKET})` : ""}`,
);

const a = schema.attachment;
const rows = await db
  .select({ id: a.id, organizationId: a.organizationId, storageKey: a.storageKey, mimeType: a.mimeType })
  .from(a)
  .where(sql`${a.storageKey} is not null and ${a.fileId} is null`);
let moved = 0;
let merged = 0;
let missing = 0;
for (const r of rows) {
  if (!r.storageKey || !(await from.exists(r.storageKey))) {
    missing++;
    continue;
  }
  const bytes = await from.get(r.storageKey);
  const { file, reused } = await storeFile(db, to, {
    organizationId: r.organizationId,
    bytes,
    mimeType: r.mimeType,
    newId: () => newId("storedFile"),
    quota: "count",
  });
  await db.update(a).set({ fileId: file.id, storageKey: file.storageKey }).where(sql`${a.id} = ${r.id}`);
  if (reused) merged++;
  else moved++;
}

// Stored files written to local disk before S3 was set up: copy any the bucket doesn't have yet.
let filled = 0;
if (to.driver !== "local")
  for (const f of await db.select().from(schema.storedFile))
    if (!(await to.exists(f.storageKey)) && (await from.exists(f.storageKey))) {
      await to.put(f.storageKey, await from.get(f.storageKey), { contentType: f.mimeType });
      filled++;
    }

// Spreadsheets still being mapped or imported (finished ones aren't needed).
const im = schema.contactImport;
const imports = await db
  .select({ id: im.id, storageKey: im.storageKey })
  .from(im)
  .where(sql`${im.status} in ('reading', 'mapping', 'queued', 'running')`);
let copied = 0;
if (to.driver !== "local")
  for (const i of imports)
    if (await from.exists(i.storageKey)) {
      await to.put(i.storageKey, await from.get(i.storageKey));
      copied++;
    }

console.log(
  `Attachments: ${moved} stored, ${merged} merged with an identical file, ${missing} missing on disk`,
);
console.log(`Stored files copied from disk: ${filled}`);
console.log(`Imports in progress copied: ${copied}`);
await client.end();
