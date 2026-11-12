/*
 * Re-runs stored webhook events through the worker, for example after fixing a bug.
 *   pnpm --filter @relay/worker replay [--failed] [--unrouted] [--since 2026-11-13T00:00:00Z]
 * Re-running is safe: messages are deduplicated and statuses only move forward.
 */
import { env, queues } from "@relay/core";
import { and, createDb, gte, isNotNull, schema, sql } from "@relay/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const config = env();
const args = process.argv.slice(2);
const since = args.includes("--since") ? new Date(args[args.indexOf("--since") + 1] ?? "") : null;
const { db, sql: close } = createDb(config.DATABASE_URL);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(queues.webhooks, { connection });

const filters = [
  args.includes("--failed") ? isNotNull(schema.webhookEvent.error) : undefined,
  args.includes("--unrouted") ? sql`${schema.webhookEvent.unrouted} = true` : undefined,
  since ? gte(schema.webhookEvent.receivedAt, since) : undefined,
].filter(Boolean);

const rows = await db
  .select({ id: schema.webhookEvent.id })
  .from(schema.webhookEvent)
  .where(filters.length ? and(...filters) : undefined);

for (const row of rows) {
  await queue.add(
    "meta",
    { eventId: row.id },
    { jobId: `${row.id}:replay:${Date.now()}`, attempts: 3, removeOnComplete: true },
  );
}
console.log(`Queued ${rows.length} event(s) for replay`);
await queue.close();
connection.disconnect();
await close.end();
