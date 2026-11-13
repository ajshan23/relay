/** Queue names shared by the API (producer) and the worker (consumer). */
export const queues = {
  webhooks: "webhooks",
  /** Outbound channel messages. The job id is the message id. */
  outbox: "outbox",
  emails: "emails",
  media: "media",
  /** Publishing, editing, removing and importing message templates on channels. */
  templates: "templates",
  /** Contact imports from Excel or CSV. The job id is the import id. */
  contacts: "contacts",
} as const;

export type QueueName = (typeof queues)[keyof typeof queues];
