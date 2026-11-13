import { env, queues } from "@relay/core";
import { createDb, schema, sql } from "@relay/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

/*
 * Queues previews for stored images and videos that don't have one yet (files stored before previews
 * existed). The running worker makes them. Run: pnpm --filter @relay/worker previews:backfill
 */

const config = env();
const { db, sql: client } = createDb(config.DATABASE_URL);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(queues.previews, { connection });
const f = schema.storedFile;
const rows = await db
  .select({ id: f.id })
  .from(f)
  .where(sql`${f.previewKey} is null and (${f.mimeType} like 'image/%' or ${f.mimeType} like 'video/%')`);
for (const r of rows) await queue.add("preview", { fileId: r.id }, { jobId: `preview_${r.id}`, attempts: 2 });
console.log(`Queued ${rows.length} previews`);
await queue.close();
connection.disconnect();
await client.end();
