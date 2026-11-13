import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { branch } from "./branches";
import { channelAccount } from "./channels";
import { contact, message } from "./messaging";

/*
 * Broadcasts: one message sent to many people on one channel (WhatsApp now; SMS and email later).
 * The audience is frozen into broadcast_recipient rows when it starts, so deleting a list or contact
 * afterwards changes nothing, and Postgres (not the queue) is the record of who got what: a restart,
 * a crash or a lost Redis carries on from the rows.
 */

export const broadcastStatus = pgEnum("broadcast_status", [
  "draft",
  "scheduled",
  /** Turning the audience into recipients. */
  "preparing",
  "sending",
  "paused",
  "completed",
  /** Stopped by someone (or because its message can't be sent at all); the rest are skipped. */
  "stopped",
  /** Couldn't start (for example its list was deleted before it began). */
  "failed",
]);

export const recipientStatus = pgEnum("broadcast_recipient_status", [
  "pending",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "skipped",
]);

/** What a broadcast sends, per channel. */
export type BroadcastContent =
  | {
      kind: "template";
      templateId: string;
      /** Each template detail: fixed text, or a contact field with a fallback. */
      values: Record<
        string,
        { source: "static"; text: string } | { source: "field"; key: string; fallback?: string }
      >;
    }
  | { kind: "text"; text: string }
  | { kind: "email"; subject: string; html: string };

export type BroadcastAudience = { listIds: string[]; excludeListIds: string[]; filter?: unknown };

export type BroadcastSchedule = {
  /** ISO time, or null for "as soon as it's started". */
  startAt: string | null;
  /** IANA time zone the sending hours are in (the branch's). */
  timezone: string;
  /** Only send on these weekdays (1 = Monday … 7 = Sunday), between these local times. */
  window: { days: number[]; from: string; to: string } | null;
  /** Most messages per day; null means 75% of the channel's daily limit. */
  perDay: number | null;
  /** Spread the sending so it finishes by then (ISO), instead of a fixed per-day number. */
  endBy: string | null;
};

export const broadcast = pgTable(
  "broadcast",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    channelType: text("channel_type").notNull(),
    channelAccountId: text("channel_account_id").references(() => channelAccount.id, {
      onDelete: "set null",
    }),
    content: jsonb("content").$type<BroadcastContent>().notNull(),
    audience: jsonb("audience").$type<BroadcastAudience>().notNull(),
    schedule: jsonb("schedule").$type<BroadcastSchedule>().notNull(),
    status: broadcastStatus("status").notNull().default("draft"),
    /** Why it's paused or stopped: manual, template_paused, template_disabled, template_quality, number_quality, spam_limit, auth, billing, error_rate, template_invalid, list_deleted. */
    pauseReason: text("pause_reason"),
    pauseDetail: text("pause_detail"),
    total: integer("total").notNull().default(0),
    pending: integer("pending").notNull().default(0),
    sent: integer("sent").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    read: integer("read").notNull().default(0),
    replied: integer("replied").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("broadcast_branch_idx").on(t.branchId, t.createdAt),
    index("broadcast_status_idx").on(t.status),
  ],
);

export const broadcastRecipient = pgTable(
  "broadcast_recipient",
  {
    id: text("id").primaryKey(),
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => broadcast.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contact.id, { onDelete: "set null" }),
    /** Phone or email, frozen when the broadcast started. */
    address: text("address").notNull(),
    status: recipientStatus("status").notNull().default("pending"),
    /** opted_out, no_address, missing_value, contact_deleted, stopped */
    skipReason: text("skip_reason"),
    messageId: text("message_id").references(() => message.id, { onDelete: "set null" }),
    errorCode: text("error_code"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    /** Pending again after a temporary failure: not before this. */
    retryAt: timestamp("retry_at"),
    sentAt: timestamp("sent_at"),
    repliedAt: timestamp("replied_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("broadcast_recipient_address_uidx").on(t.broadcastId, t.address),
    index("broadcast_recipient_status_idx").on(t.broadcastId, t.status, t.retryAt),
    index("broadcast_recipient_message_idx").on(t.messageId),
  ],
);
