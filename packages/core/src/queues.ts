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
  /** Small previews of stored images and videos. The job id is preview_<stored file id>. */
  previews: "previews",
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
