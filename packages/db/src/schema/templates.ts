import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { channelAccount } from "./channels";

/*
 * Message templates, on any channel. A template is written once (message_template) and published to
 * the channels a business picks (template_channel), each with its own review state. Content shapes
 * live in @relay/core/templates; adapters translate them.
 */

export const templateStatus = pgEnum("template_status", [
  "draft",
  "in_review",
  "ready",
  "needs_changes",
  "paused",
  "disabled",
]);

export const messageTemplate = pgTable(
  "message_template",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The name people see, e.g. "Appointment reminder". */
    name: text("name").notNull(),
    /** Channel-safe name, e.g. appointment_reminder. Fixed once published (channels key on it). */
    slug: text("slug").notNull(),
    language: text("language").notNull().default("en"),
    /** updates | marketing | login */
    purpose: text("purpose").notNull(),
    /** TemplateContent: header, body with {{details}}, footer, buttons. */
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    /** TemplateVariable[]: each detail with its example. */
    variables: jsonb("variables").$type<{ name: string; example: string }[]>().notNull().default([]),
    /** Where it came from: written in Relay, a library entry, or imported from a channel. */
    source: text("source").notNull().default("relay"),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("message_template_slug_uidx").on(t.organizationId, t.slug, t.language)],
);

/** One template on one channel account, with that channel's review state. */
export const templateChannel = pgTable(
  "template_channel",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    templateId: text("template_id")
      .notNull()
      .references(() => messageTemplate.id, { onDelete: "cascade" }),
    channelAccountId: text("channel_account_id")
      .notNull()
      .references(() => channelAccount.id, { onDelete: "cascade" }),
    /** Accounts sharing templates (WhatsApp: one business account) share one channel copy id. */
    scope: text("scope").notNull(),
    /** The channel's template id, once submitted. */
    externalId: text("external_id"),
    status: templateStatus("status").notNull().default("draft"),
    /** The reviewer's reason, in plain words. */
    reason: text("reason"),
    /** Meta's quality rating for the template on this account: GREEN, YELLOW, RED (null: unknown). */
    quality: text("quality"),
    /** The last error while publishing (not a review result), e.g. the channel was unreachable. */
    error: text("error"),
    submittedAt: timestamp("submitted_at"),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_channel_uidx").on(t.templateId, t.channelAccountId),
    index("template_channel_external_idx").on(t.externalId),
    index("template_channel_account_idx").on(t.channelAccountId, t.status),
  ],
);
