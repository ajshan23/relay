/** Queue names shared by the API (producer) and the worker (consumer). */
export const queues = {
  webhooks: "webhooks",
  /** Outbound channel messages. The job id is the message id. */
  outbox: "outbox",
  emails: "emails",
  media: "media",
  /** Publishing, editing, removing and importing message templates on channels. */
  templates: "templates",
  /** Contact imports from Excel or CSV, one at a time. The job id is the import id. */
  contacts: "contacts",
  /**
   * Contacts files, a few at once: "read" an uploaded file (job id read_<import id>) and "export" a
   * view to a file (job id export_<uuid>).
   */
  contactFiles: "contact-files",
  /**
   * Small signals to the customer's app: "read" (blue ticks; job id read_<message id>) and "typing"
   * (job id typing_<conversation id>_<20 s slot>). Best effort: dropped rather than retried for long.
   */
  signals: "signals",
  /** Housekeeping on a timer: "wake-snoozed" every minute. */
  maintenance: "maintenance",
  /** The broadcast engine's timers: "tick" every 10 s, "reconcile" every minute. */
  broadcasts: "broadcasts",
  /** Small previews of stored images and videos. The job id is preview_<stored file id>. */
  previews: "previews",
  /**
   * After a number is connected through Embedded Signup: "coexistence-sync" asks Meta for the phone
   * app's contacts, then its chat history (job id coexistence_<channel id>); "coexistence-expire"
   * closes the 24-hour window.
   */
  onboarding: "onboarding",
  /** AI agent knowledge: "index" one source (job id index_<source id>_<revision>), one business at a time. */
  knowledge: "knowledge",
  /**
   * The catalogue: "embed" a branch's changed items (job id embed_<branch>_<10 s slot>), "import" an
   * Excel/CSV file (job id the import id).
   */
  catalog: "catalog",
  /** Catalogue gallery files: "prepare" one upload for WhatsApp (job id the media id). */
  catalogMedia: "catalog-media",
} as const;

export type QueueName = (typeof queues)[keyof typeof queues];

/** A contacts export, compiled by the API and run by the worker (queue "contact-files", job "export"). */
export type ExportJob = {
  orgId: string;
  branchId: string;
  userId: string;
  /** The table's query, with its parameters. */
  sql: string;
  params: unknown[];
  /** Names of the query's columns, in order. */
  keys: string[];
  /** The table's visible columns, in order. */
  columns: string[];
  format: "xlsx" | "csv";
};

export type ExportResult = { storageKey: string; fileName: string; rows: number };

/** A read receipt or typing signal for one conversation (queue "signals"). */
export type SignalJob = { kind: "read" | "typing"; conversationId: string; messageId: string };

/** Make the preview of a stored file (queue "previews"). */
export type PreviewJob = { fileId: string };
