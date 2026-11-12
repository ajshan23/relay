import { createServer } from "node:http";
import { env, queues } from "@relay/core";
import { createDb } from "@relay/db";
import { createEmailSender, type EmailJob, providerFromEnv } from "@relay/email";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createWebhookProcessor, type MediaJob, type WebhookJob } from "./channels/webhooks";

const config = env();
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const { db, sql } = createDb(config.DATABASE_URL);

/* Emails: every email Relay sends is rendered and handed to the provider here, with retries. */
const emailProvider = providerFromEnv();
const emails = new Worker<EmailJob>(queues.emails, createEmailSender({ db, provider: emailProvider }), {
  connection,
  concurrency: 5,
});
emails.on("ready", () => console.log(`emails worker ready (provider: ${emailProvider.name})`));

/* Channel webhooks: stored raw by the API, turned into contacts, conversations and messages here. */
const mediaQueue = new Queue<MediaJob>(queues.media, { connection });
const webhooks = new Worker<WebhookJob>(queues.webhooks, createWebhookProcessor({ db, mediaQueue }), {
  connection,
  concurrency: 10,
});
webhooks.on("failed", (job, err) =>
  console.error(`webhook ${job?.data.eventId} failed (attempt ${job?.attemptsMade})`, err.message),
);

/* Health check for the process manager (and the local launcher): 200 while the workers run. */
const port = Number(process.env.WORKER_PORT ?? 3202);
const health = createServer((_req, res) => {
  const ok = emails.isRunning() && webhooks.isRunning();
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, workers: { emails: emails.isRunning(), webhooks: webhooks.isRunning() } }));
});
health.listen(port, () => console.log(`worker health on :${port}`));

async function shutdown() {
  health.close();
  await Promise.all([emails.close(), webhooks.close(), mediaQueue.close()]);
  connection.disconnect();
  await sql.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
