import { env, queues } from "@relay/core";
import { createDb } from "@relay/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

/** Long-lived connections, created once at startup and passed to modules. */
export function createContext() {
  const config = env();
  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const webhookQueue = new Queue(queues.webhooks, { connection: redis });
  const outboxQueue = new Queue(queues.outbox, { connection: redis });
  const templatesQueue = new Queue(queues.templates, { connection: redis });
  const contactsQueue = new Queue(queues.contacts, { connection: redis });
  const contactFilesQueue = new Queue(queues.contactFiles, { connection: redis });
  const signalsQueue = new Queue(queues.signals, { connection: redis });

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
    },
    async close() {
      await Promise.all([
        webhookQueue.close(),
        outboxQueue.close(),
        templatesQueue.close(),
        contactsQueue.close(),
        contactFilesQueue.close(),
        signalsQueue.close(),
      ]);
      redis.disconnect();
      await sql.end();
    },
  };
}

export type AppContext = ReturnType<typeof createContext>;
