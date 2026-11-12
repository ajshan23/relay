import { newId, queues } from "@relay/core";
import { type createDb, schema } from "@relay/db";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { catalog, type EmailData, type EmailKind } from "./catalog";

export type Db = ReturnType<typeof createDb>["db"];

/** What travels through the queue. Holds the template data (codes, links), so jobs are deleted soon after. */
export type EmailJob<K extends EmailKind = EmailKind> = {
  logId: string;
  kind: K;
  to: string;
  data: EmailData[K];
};

export type QueueEmailOptions = { userId?: string; organizationId?: string };

/** Retry policy by category: account emails only matter for minutes; the rest can wait longer. */
const retries = {
  account: { attempts: 4, backoff: { type: "exponential", delay: 2_000 } },
  team: { attempts: 6, backoff: { type: "exponential", delay: 10_000 } },
  product: { attempts: 6, backoff: { type: "exponential", delay: 30_000 } },
} as const;

/**
 * The one way to send an email from Relay: record it in email_log, then hand it to the worker
 * through the emails queue. Returns at once; the worker sends it and retries on failure.
 */
export function createEmailOutbox({ db, connection }: { db: Db; connection: Redis }) {
  const queue = new Queue<EmailJob>(queues.emails, { connection });

  async function queueEmail<K extends EmailKind>(
    kind: K,
    to: string,
    data: EmailData[K],
    options: QueueEmailOptions = {},
  ): Promise<string> {
    const definition = catalog[kind];
    const logId = newId("email");
    await db.insert(schema.emailLog).values({
      id: logId,
      kind,
      to,
      subject: definition.subject(data),
      userId: options.userId,
      organizationId: options.organizationId,
    });
    await queue.add(kind, { logId, kind, to, data } as EmailJob, {
      jobId: logId,
      ...retries[definition.category],
      // The job holds codes and links: keep it no longer than needed.
      removeOnComplete: true,
      removeOnFail: { age: 24 * 60 * 60 },
    });
    return logId;
  }

  return { queueEmail, close: () => queue.close() };
}

export type EmailOutbox = ReturnType<typeof createEmailOutbox>;
