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

  return {
    config,
    db,
    redis,
    queues: { webhooks: webhookQueue },
    async close() {
      await webhookQueue.close();
      redis.disconnect();
      await sql.end();
    },
  };
}

export type AppContext = ReturnType<typeof createContext>;
