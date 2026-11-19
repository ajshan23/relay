import { createServer } from "node:http";
import {
  aiConfigured,
  createEmbedder,
  createModelCaller,
  createPhotoDescriber,
  createSpeaker,
  createTranscriber,
  speechConfigured,
} from "@relay/agent";
import { type ExportJob, env, fileStorage, queues, type SignalJob } from "@relay/core";
import { and, calendarDepsFrom, createDb, eq, schema } from "@relay/db";
import { catalogEmbeddingDimensions } from "@relay/db/schema";
import { createEmailSender, type EmailJob, providerFromEnv } from "@relay/email";
import { type Job, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createKnowledgeProcessor, type KnowledgeJob } from "./agent/knowledge";
import { createPhotoReader } from "./agent/photos";
import { createVoiceListener } from "./agent/voice";
import { createAutomations } from "./automations/runtime";
import { createBookingReminders } from "./bookings/reminders";
import { createBroadcastEngine, outboxJobOptions } from "./broadcasts/engine";
import { type EmbedJob as CatalogEmbedJob, createCatalogEmbedder } from "./catalog/embed";
import { type ImportJob as CatalogImportJob, createCatalogImporter } from "./catalog/import";
import { type MediaJob as CatalogMediaJob, createCatalogMediaProcessor } from "./catalog/media";
import { createMediaProcessor } from "./channels/media";
import { createOnboardingProcessor, type OnboardingJob } from "./channels/onboarding";
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
import { onePerOrg } from "./lib/per-org";
import { createRequeue, redisMemory } from "./maintenance/requeue";

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

/* Automations run on Kairos (Postgres only): durable steps, waits for replies, delays. */
const automationOutbox = new Queue(queues.outbox, { connection });
const automationSignals = new Queue(queues.signals, { connection });
/* Google Calendars for bookings (null without Google or the encryption key: Relay's own book only). */
const bookingCalendar = calendarDepsFrom(config);
const automations = createAutomations({
  db,
  redis: connection,
  outbox: automationOutbox,
  outboxJobOptions,
  databaseUrl: config.DATABASE_URL,
  listenUrl: config.KAIROS_LISTEN_URL,
  signals: automationSignals,
  linkBase: config.WEB_URL,
  ai: aiConfigured(config)
    ? {
        callModel: createModelCaller(config),
        embed: createEmbedder(config),
        embedCatalog: createEmbedder(config, { dimensions: catalogEmbeddingDimensions }),
        hearVoiceNotes: createVoiceListener({
          db,
          redis: connection,
          storage: fileStorage(),
          transcribe: createTranscriber(config),
        }),
        seePhotos: createPhotoReader({
          db,
          redis: connection,
          storage: fileStorage(),
          describe: createPhotoDescriber(config),
        }),
        voiceReplies: speechConfigured(config)
          ? { speak: createSpeaker(config), storage: fileStorage() }
          : null,
        calendar: bookingCalendar,
        ownTools: config.CHANNEL_SECRET_KEY
          ? {
              secretKey: config.CHANNEL_SECRET_KEY,
              allowPrivate: config.AGENT_TOOLS_ALLOW_PRIVATE === "1",
            }
          : null,
      }
    : {
        callModel: null,
        embed: null,
        embedCatalog: null,
        hearVoiceNotes: null,
        seePhotos: null,
        voiceReplies: null,
      },
});
const automationWorker = automations.worker();

/* Booking reminders: a sweep every minute sends each one once. */
const stopBookingReminders = createBookingReminders({
  db,
  calendar: bookingCalendar,
  outbox: automationOutbox,
  outboxJobOptions,
}).start();
console.log(aiConfigured(config) ? "AI agent ready" : "AI agent off (no OPENAI_API_KEY)");

/* AI agent knowledge: read, cut into pieces and embed each source the business adds. */
const knowledge = new Worker<KnowledgeJob>(
  queues.knowledge,
  createKnowledgeProcessor({
    db,
    storage: fileStorage(),
    embed: aiConfigured(config) ? createEmbedder(config) : null,
  }),
  { connection, concurrency: 2 },
);
knowledge.on("failed", (job, err) => console.warn(`knowledge ${job?.data.sourceId} failed: ${err.message}`));

/* The catalogue: embed changed items (a branch at a time, batched) so Mira finds them by meaning. */
const embedCatalog = createCatalogEmbedder({
  db,
  embed: aiConfigured(config) ? createEmbedder(config, { dimensions: catalogEmbeddingDimensions }) : null,
});
const catalogQueue = new Queue(queues.catalog, { connection });
const catalogMediaQueue = new Queue(queues.catalogMedia, { connection });
const importCatalog = createCatalogImporter({
  db,
  storage: fileStorage(),
  media: catalogMediaQueue,
  embedSoon: (organizationId, branchId) =>
    catalogQueue.add(
      "embed",
      { organizationId, branchId },
      {
        jobId: `embed_${branchId}_${Math.floor(Date.now() / 10_000)}`,
        delay: 2_000,
        attempts: 3,
        removeOnComplete: true,
      },
    ),
});
type CatalogJob = CatalogEmbedJob | CatalogImportJob;
const catalog = new Worker<CatalogJob>(
  queues.catalog,
  onePerOrg<CatalogJob>(
    connection,
    "catalog",
    (job) => job.data.organizationId,
    async (job) => {
      if (job.name === "embed") return embedCatalog(job as Job<CatalogEmbedJob>);
      if (job.name === "import-read") return importCatalog.read(job as Job<CatalogImportJob>);
      if (job.name === "import") return importCatalog.run(job as Job<CatalogImportJob>);
    },
  ),
  { connection, concurrency: 2 },
);
catalog.on("failed", (job, err) => console.warn(`catalog ${job?.name} failed: ${err.message}`));
void automations
  .startWorker(automationWorker)
  .then(() =>
    console.log(`automations worker ready${config.KAIROS_LISTEN_URL ? " (instant wake-ups)" : " (polling)"}`),
  )
  .catch((err) => console.error("automations failed to start", err));

/* Channel webhooks: stored raw by the API, turned into contacts, conversations and messages here. */
const mediaQueue = new Queue<MediaJob>(queues.media, { connection });
const webhooks = new Worker<WebhookJob>(
  queues.webhooks,
  createWebhookProcessor({
    db,
    mediaQueue,
    redis: connection,
    onInbound: automations.onInbound,
    afterInbound: automations.kairos.nudge,
  }),
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

/* After Embedded Signup: coexistence contact and history sync requests (see channels/onboarding.ts). */
const onboarding = new Worker<OnboardingJob>(queues.onboarding, createOnboardingProcessor({ db }), {
  connection,
  concurrency: 5,
});
onboarding.on("failed", (job, err) =>
  console.warn(
    `onboarding ${job?.name} ${job?.data.channelAccountId} (attempt ${job?.attemptsMade}): ${err.message}`,
  ),
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
// Webhook events and outgoing messages whose queue job went missing (Redis was down or lost data) are
// put back every minute from Postgres (maintenance/requeue.ts).
void maintenanceQueue
  .upsertJobScheduler(
    "requeue-stuck",
    { every: 60_000 },
    { name: "requeue-stuck", opts: { removeOnComplete: 10, removeOnFail: 50 } },
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
const webhookQueue = new Queue(queues.webhooks, { connection });
const sweepOutbox = new Queue(queues.outbox, { connection });
const requeueStuck = createRequeue({
  db,
  redis: connection,
  webhooks: webhookQueue,
  outbox: sweepOutbox,
  outboxJobOptions,
});
const sweepFiles = createFileSweep({ db, storage: fileStorage() });
const maintenance = new Worker(
  queues.maintenance,
  async (job) => {
    if (job.name === "wake-snoozed") return wakeSnoozed();
    if (job.name === "check-template-reviews") return checkTemplateReviews();
    if (job.name === "sweep-files") return sweepFiles();
    if (job.name === "requeue-stuck") return requeueStuck();
  },
  { connection, concurrency: 1 },
);
maintenance.on("failed", (job, err) => console.error(`maintenance ${job?.name} failed: ${err.message}`));

/* Broadcasts: a tick every 10 s (start, prepare, send, sync, totals) and a reconcile every minute. */
const broadcastsQueue = new Queue(queues.broadcasts, { connection });
const outboxQueue = new Queue<OutboxJob>(queues.outbox, { connection });
for (const [name, every] of [
  ["tick", 10_000],
  ["reconcile", 60_000],
] as const)
  void broadcastsQueue
    .upsertJobScheduler(
      `broadcast-${name}`,
      { every },
      { name, opts: { removeOnComplete: 20, removeOnFail: 50 } },
    )
    .catch((err) => console.error("broadcast scheduler", err));
const broadcastEngine = createBroadcastEngine({ db, redis: connection, outbox: outboxQueue });
const broadcasts = new Worker(
  queues.broadcasts,
  async (job) => (job.name === "reconcile" ? broadcastEngine.reconcile() : broadcastEngine.tick()),
  // One at a time per worker; the database row locks keep several workers from clashing.
  { connection, concurrency: 1 },
);
broadcasts.on("failed", (job, err) => console.error(`broadcast ${job?.name} failed: ${err.message}`));

/* Small previews of stored images and video frames, for the chat. */
const previewQueue = new Queue(queues.previews, { connection });
const previews = new Worker(queues.previews, createPreviewProcessor({ db, storage: fileStorage() }), {
  connection,
  concurrency: 2,
});
previews.on("failed", (job, err) => console.warn(`preview ${job?.data.fileId} failed: ${err.message}`));

/* Catalogue gallery files: prepared for WhatsApp (photos resized, videos converted), one at a time per business. */
const prepareCatalogMedia = createCatalogMediaProcessor({
  db,
  storage: fileStorage(),
  previews: previewQueue,
});
const catalogMedia = new Worker<CatalogMediaJob>(
  queues.catalogMedia,
  onePerOrg<CatalogMediaJob>(
    connection,
    "catalog-media",
    async (job) =>
      (
        await db
          .select({ org: schema.catalogMedia.organizationId })
          .from(schema.catalogMedia)
          .where(eq(schema.catalogMedia.id, job.data.mediaId))
          .limit(1)
      )[0]?.org ?? null,
    prepareCatalogMedia,
  ),
  { connection, concurrency: 3 },
);
catalogMedia.on("failed", (job, err) =>
  console.warn(`catalog media ${job?.data.mediaId} failed: ${err.message}`),
);

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
  void (async () => {
    const workersOk =
      emails.isRunning() &&
      webhooks.isRunning() &&
      outbox.isRunning() &&
      media.isRunning() &&
      templates.isRunning();
    // Redis: reachable, and how full (jobs fail once maxmemory is reached with noeviction).
    const redis = await Promise.race([
      redisMemory(connection).then((m) => ({ ok: true, ...m })),
      new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), 1000)),
    ]).catch(() => ({ ok: false as const }));
    const ok = workersOk && redis.ok;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok,
        redis,
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
          broadcasts: broadcasts.isRunning(),
          knowledge: knowledge.isRunning(),
        },
        automations: { busy: automationWorker.busy, ...automationWorker.stats },
      }),
    );
  })();
});
health.listen(port, config.HOST, () => console.log(`worker health on ${config.HOST}:${port}`));

async function shutdown() {
  health.close();
  stopBookingReminders();
  // Automations first: running steps finish (up to 25 s) and the rest is handed back.
  await automations.kairos.close();
  await Promise.all([
    automationOutbox.close(),
    automationSignals.close(),
    emails.close(),
    webhooks.close(),
    outbox.close(),
    media.close(),
    catalogMedia.close(),
    catalog.close(),
    templates.close(),
    contactImports.close(),
    contactFiles.close(),
    signals.close(),
    onboarding.close(),
    maintenance.close(),
    previews.close(),
    broadcasts.close(),
    knowledge.close(),
    broadcastsQueue.close(),
    outboxQueue.close(),
    previewQueue.close(),
    maintenanceQueue.close(),
    templatesQueue.close(),
    mediaQueue.close(),
    webhookQueue.close(),
    sweepOutbox.close(),
  ]);
  connection.disconnect();
  await sql.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
