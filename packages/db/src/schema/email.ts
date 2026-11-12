import { index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const emailStatus = pgEnum("email_status", ["queued", "sent", "failed"]);

/**
 * One row per email Relay sends: what, to whom, and what happened. The body and its data
 * (codes, reset links) are never stored here; they live only in the queue until sent.
 */
export const emailLog = pgTable(
  "email_log",
  {
    id: text("id").primaryKey(),
    /** The catalog entry, for example "verify-code" or "team-invitation". */
    kind: text("kind").notNull(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    status: emailStatus("status").notNull().default("queued"),
    /** "resend", or "log" in local development without a key. */
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    attempts: integer("attempts").notNull().default(0),
    /** The last error, in the provider's words. */
    error: text("error"),
    /** Optional links back, for support and per-business history. */
    userId: text("user_id"),
    organizationId: text("organization_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    sentAt: timestamp("sent_at"),
  },
  (t) => [
    index("email_log_to_idx").on(t.to, t.createdAt),
    index("email_log_status_idx").on(t.status, t.createdAt),
    index("email_log_org_idx").on(t.organizationId, t.createdAt),
  ],
);
