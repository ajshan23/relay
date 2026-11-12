/** Queue names shared by the API (producer) and the worker (consumer). */
export const queues = {
  webhooks: "webhooks",
  outbox: "outbox",
  emails: "emails",
} as const;

export type QueueName = (typeof queues)[keyof typeof queues];
