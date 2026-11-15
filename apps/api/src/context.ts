import { env, queues } from "@relay/core";
import { createDb } from "@relay/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

/** Long-lived connections, created once at startup and passed to modules. */
export function createContext() {
  const config = env();
  const { db, sql } = createDb(config.DATABASE_URL);
  // Queues keep their own connection: BullMQ needs one that waits for Redis rather than failing.
  // Adds go through enqueue() (lib/enqueue.ts) so a request never waits on it.
  const queueConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  // Everything else (caches, live inbox hints, presence) is best effort and must never hold up a
  // request: while Redis is away these calls fail at once and the caller carries on without them.
  const redis = new Redis(config.REDIS_URL, {
    enableOfflineQueue: false,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
  });
  let lastRedisError = 0;
  for (const client of [redis, queueConnection])
    client.on("error", (err) => {
      if (Date.now() - lastRedisError < 30_000) return;
      lastRedisError = Date.now();
      console.warn(`redis unavailable: ${err.message} (Postgres keeps working; queued work catches up)`);
    });
  const connection = queueConnection;
  const webhookQueue = new Queue(queues.webhooks, { connection });
  const outboxQueue = new Queue(queues.outbox, { connection });
  const templatesQueue = new Queue(queues.templates, { connection });
  const contactsQueue = new Queue(queues.contacts, { connection });
  const contactFilesQueue = new Queue(queues.contactFiles, { connection });
  const signalsQueue = new Queue(queues.signals, { connection });
  const previewsQueue = new Queue(queues.previews, { connection });
  const onboardingQueue = new Queue(queues.onboarding, { connection });

  return {
    config,
    db,
    redis,
    queues: {
      webhooks: webhookQueue,
      outbox: outboxQueue,
      templates: templatesQueue,
      contacts: contactsQueue,
      contactFiles: contactFilesQueue,
      signals: signalsQueue,
      previews: previewsQueue,
      onboarding: onboardingQueue,
    },
    async close() {
      await Promise.all([
        webhookQueue.close(),
        outboxQueue.close(),
        templatesQueue.close(),
        contactsQueue.close(),
        contactFilesQueue.close(),
        signalsQueue.close(),
        previewsQueue.close(),
        onboardingQueue.close(),
      ]);
      redis.disconnect();
      queueConnection.disconnect();
      await sql.end();
    },
  };
}

export type AppContext = ReturnType<typeof createContext>;
