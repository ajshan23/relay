import { type createDb, sql } from "@relay/db";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

/*
 * Postgres is the truth and Redis jobs are only nudges, so anything whose job went missing (Redis was
 * down when the API tried to queue it, or Redis lost its data) is put back every minute:
 *   - webhook events stored but never processed (the API saves them before queueing)
 *   - outgoing chat messages still "queued" after 2 minutes (broadcasts have their own reconcile)
 * Job ids are the row ids, so a job that still exists is left alone and nothing runs twice; the outbox
 * itself also refuses to send a message twice.
 * It also warns when Redis memory runs close to its limit (jobs would start failing at 100%).
 */

type Db = ReturnType<typeof createDb>["db"];

const webhookJobOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const;

export function createRequeue({
  db,
  redis,
  webhooks,
  outbox,
  outboxJobOptions,
}: {
  db: Db;
  redis: Redis;
  webhooks: Queue;
  outbox: Queue;
  outboxJobOptions: Record<string, unknown>;
}) {
  return async () => {
    // Only recent rows: an event that kept failing for a day needs a person (and a replay), not a loop.
    const events = (await db.execute(sql`
      select id from webhook_event
      where processed_at is null
        and received_at < (now() at time zone 'utc') - interval '1 minute'
        and received_at > (now() at time zone 'utc') - interval '1 day'
      order by received_at limit 500`)) as unknown as { id: string }[];
    for (const e of events)
      await webhooks.add("meta", { eventId: e.id }, { jobId: e.id, ...webhookJobOptions });

    const messages = (await db.execute(sql`
      select id from message
      where status = 'queued' and direction = 'outbound' and broadcast_id is null and type <> 'note'
        and created_at < (now() at time zone 'utc') - interval '2 minutes'
        and created_at > (now() at time zone 'utc') - interval '1 day'
      order by created_at limit 500`)) as unknown as { id: string }[];
    for (const m of messages)
      await outbox.add("send", { messageId: m.id }, { jobId: m.id, ...outboxJobOptions });

    const memory = await redisMemory(redis);
    if (memory.ratio !== null && memory.ratio > 0.8)
      console.warn(
        `redis memory at ${Math.round(memory.ratio * 100)}% of maxmemory: new jobs will fail when it is full`,
      );
    return { webhookEvents: events.length, messages: messages.length, redisMemory: memory.ratio };
  };
}

/** Used and maximum memory from INFO memory; ratio is null when no maxmemory is set. */
export async function redisMemory(redis: Redis) {
  const info = await redis.info("memory");
  const read = (key: string) => Number(new RegExp(`^${key}:(\\d+)`, "m").exec(info)?.[1] ?? 0);
  const used = read("used_memory");
  const max = read("maxmemory");
  return { usedBytes: used, maxBytes: max || null, ratio: max ? used / max : null };
}
