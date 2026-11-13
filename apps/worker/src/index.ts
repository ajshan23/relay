import { createServer } from "node:http";
import { type ExportJob, env, fileStorage, queues, type SignalJob } from "@relay/core";
import { and, createDb, eq, schema } from "@relay/db";
import { createEmailSender, type EmailJob, providerFromEnv } from "@relay/email";
import { type Job, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createMediaProcessor } from "./channels/media";
import { createOutboxProcessor, type OutboxJob } from "./channels/outbox";
import { createSignalProcessor } from "./channels/signals";
import { createTemplateProcessor, type TemplateJob } from "./channels/templates";
import { createWebhookProcessor, type MediaJob, type WebhookJob } from "./channels/webhooks";
import { createExportProcessor } from "./contacts/export";
import { createImportProcessor, type ImportJob } from "./contacts/import";
import { createReadProcessor, type ReadJob } from "./contacts/read";
import { createSnoozeWaker } from "./conversations/snooze";
import { createPreviewProcessor } from "./files/preview";
import { createFileSweep } from "./files/sweep";

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
const webhooks = new Worker<WebhookJob>(
  queues.webhooks,
  createWebhookProcessor({ db, mediaQueue, redis: connection }),
  {
    connection,
    concurrency: 10,
  },
);
/* Outbound channel messages, with per-number throttling and safe retries. */
const outbox = new Worker<OutboxJob>(queues.outbox, createOutboxProcessor({ db, redis: connection }), {
  connection,
  concurrency: 20,
});
outbox.on("failed", (job, err) =>
  console.error(`send ${job?.data.messageId} failed (attempt ${job?.attemptsMade}): ${err.message}`),
);

/* Read receipts and "typing…" for customers: small, many, best effort. */
const signals = new Worker<SignalJob>(queues.signals, createSignalProcessor({ db }), {
  connection,
  concurrency: 20,
});
signals.on("failed", (job, err) =>
  console.warn(`signal ${job?.data.kind} ${job?.data.messageId}: ${err.message}`),
);

/* Housekeeping on a timer. One scheduler entry per job, so several workers never double up. */
const maintenanceQueue = new Queue(queues.maintenance, { connection });
void maintenanceQueue
  .upsertJobScheduler(
    "wake-snoozed",
    { every: 60_000 },
    { name: "wake-snoozed", opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
  .catch((err) => console.error("maintenance scheduler", err));
void maintenanceQueue
  .upsertJobScheduler(
    "sweep-files",
    { pattern: "30 3 * * *" },
    { name: "sweep-files", opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
  .catch((err) => console.error("maintenance scheduler", err));
// Template reviews: Meta tells us by webhook, but a missed one (a changed tunnel, an outage) must not
// leave a template "in review" forever, so pending ones are re-checked every 10 minutes.
void maintenanceQueue
  .upsertJobScheduler(
    "check-template-reviews",
    { every: 10 * 60_000 },
    { name: "check-template-reviews", opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
  .catch((err) => console.error("maintenance scheduler", err));
const templatesQueue = new Queue(queues.templates, { connection });
async function checkTemplateReviews() {
  const rows = await db
    .selectDistinct({ id: schema.templateChannel.channelAccountId })
    .from(schema.templateChannel)
    .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.templateChannel.channelAccountId))
    .where(and(eq(schema.templateChannel.status, "in_review"), eq(schema.channelAccount.status, "active")));
  for (const r of rows)
    await templatesQueue.add(
      "sync",
      { action: "sync", channelAccountId: r.id },
      {
        jobId: `sync_${r.id}_${Math.floor(Date.now() / 600_000)}`,
        attempts: 2,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  return { accounts: rows.length };
}
const wakeSnoozed = createSnoozeWaker({ db, redis: connection });
const sweepFiles = createFileSweep({ db, storage: fileStorage() });
const maintenance = new Worker(
  queues.maintenance,
  async (job) => {
    if (job.name === "wake-snoozed") return wakeSnoozed();
    if (job.name === "check-template-reviews") return checkTemplateReviews();
    if (job.name === "sweep-files") return sweepFiles();
  },
  { connection, concurrency: 1 },
);
maintenance.on("failed", (job, err) => console.error(`maintenance ${job?.name} failed: ${err.message}`));

/* Small previews of stored images and video frames, for the chat. */
const previewQueue = new Queue(queues.previews, { connection });
const previews = new Worker(queues.previews, createPreviewProcessor({ db, storage: fileStorage() }), {
  connection,
  concurrency: 2,
});
previews.on("failed", (job, err) => console.warn(`preview ${job?.data.fileId} failed: ${err.message}`));

/* Customer media: copied from Meta into our storage soon after arrival. */
const media = new Worker<MediaJob>(
  queues.media,
  createMediaProcessor({ db, redis: connection, previewQueue }),
  {
    connection,
    concurrency: 5,
  },
);
media.on("failed", (job, err) =>
  console.error(`media ${job?.data.attachmentId} failed (attempt ${job?.attemptsMade}): ${err.message}`),
);

webhooks.on("failed", (job, err) =>
  console.error(`webhook ${job?.data.eventId} failed (attempt ${job?.attemptsMade})`, err.message),
);

/* Contact imports from Excel or CSV: one at a time, rows in order, a batch at a time. */
const contactImports = new Worker<ImportJob>(queues.contacts, createImportProcessor({ db }), {
  connection,
  concurrency: 1,
});
contactImports.on("failed", (job, err) =>
  console.error(`contact import ${job?.data.importId} failed: ${err.message}`),
);

/* Contacts files: reading uploaded spreadsheets and writing exports, off the API's CPU. */
const readFile = createReadProcessor({ db });
const writeExport = createExportProcessor({ db, sql });
const contactFiles = new Worker(
  queues.contactFiles,
  async (job: Job) => {
    if (job.name === "read") return readFile(job as Job<ReadJob>);
    if (job.name === "export") return writeExport(job as Job<ExportJob>);
    throw new Error(`Unknown contacts file job "${job.name}".`);
  },
  { connection, concurrency: 3 },
);
contactFiles.on("failed", (job, err) =>
  console.error(`contacts ${job?.name} ${job?.id} failed: ${err.message}`),
);

/* Message templates: publishing to channels, removing, importing. */
const templates = new Worker<TemplateJob>(
  queues.templates,
  createTemplateProcessor({ db, redis: connection }),
  {
    connection,
    concurrency: 5,
  },
);
templates.on("failed", (job, err) =>
  console.error(`template ${job?.data.action} failed (attempt ${job?.attemptsMade}): ${err.message}`),
);

/* Health check for the process manager (and the local launcher): 200 while the workers run. */
const port = Number(process.env.WORKER_PORT ?? 3202);
const health = createServer((_req, res) => {
  const ok =
    emails.isRunning() &&
    webhooks.isRunning() &&
    outbox.isRunning() &&
    media.isRunning() &&
    templates.isRunning();
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok,
      workers: {
        emails: emails.isRunning(),
        webhooks: webhooks.isRunning(),
        outbox: outbox.isRunning(),
        media: media.isRunning(),
        templates: templates.isRunning(),
        contacts: contactImports.isRunning(),
        contactFiles: contactFiles.isRunning(),
        signals: signals.isRunning(),
        maintenance: maintenance.isRunning(),
        previews: previews.isRunning(),
      },
    }),
  );
});
health.listen(port, () => console.log(`worker health on :${port}`));

async function shutdown() {
  health.close();
  await Promise.all([
    emails.close(),
    webhooks.close(),
    outbox.close(),
    media.close(),
    templates.close(),
    contactImports.close(),
    contactFiles.close(),
    signals.close(),
    maintenance.close(),
    previews.close(),
    previewQueue.close(),
    maintenanceQueue.close(),
    templatesQueue.close(),
    mediaQueue.close(),
  ]);
  connection.disconnect();
  await sql.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
