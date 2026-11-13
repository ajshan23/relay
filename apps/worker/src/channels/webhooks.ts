import { type createDb, eq, schema, sql } from "@relay/db";
import type { Job, Queue } from "bullmq";
import { createIngest } from "./ingest";
import { channels } from "./registry";

type Db = ReturnType<typeof createDb>["db"];
export type WebhookJob = { eventId: string };
export type MediaJob = { attachmentId: string };

/**
 * Processes one stored webhook: parse, ingest, queue media downloads, and record the outcome on the
 * webhook_event row. Throwing makes the queue retry; the raw event stays stored for replay.
 */
export function createWebhookProcessor({ db, mediaQueue }: { db: Db; mediaQueue: Queue<MediaJob> }) {
  const { ingest } = createIngest(db, channels());

  return async function processWebhook(job: Job<WebhookJob>) {
    const [event] = await db
      .select()
      .from(schema.webhookEvent)
      .where(eq(schema.webhookEvent.id, job.data.eventId))
      .limit(1);
    if (!event) return;
    try {
      const result = await ingest(channels().parse(event.provider, event.payload));
      for (const attachmentId of result.media) {
        await mediaQueue.add(
          "download",
          { attachmentId },
          {
            jobId: attachmentId,
            attempts: 5,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: true,
            removeOnFail: { age: 7 * 24 * 60 * 60 },
          },
        );
      }
      await db
        .update(schema.webhookEvent)
        .set({
          processedAt: new Date(),
          attempts: sql`${schema.webhookEvent.attempts} + 1`,
          error: null,
          unrouted: result.unrouted > 0,
        })
        .where(eq(schema.webhookEvent.id, event.id));
    } catch (err) {
      await db
        .update(schema.webhookEvent)
        .set({
          attempts: sql`${schema.webhookEvent.attempts} + 1`,
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(schema.webhookEvent.id, event.id));
      throw err;
    }
  };
}
