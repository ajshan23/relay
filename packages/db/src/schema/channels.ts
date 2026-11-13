import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { branch } from "./branches";

export const channelType = pgEnum("channel_type", [
  "whatsapp",
  "instagram",
  "messenger",
  "webchat",
  "sms",
  "email",
]);
export const channelStatus = pgEnum("channel_status", ["active", "disconnected", "error"]);

/**
 * One connected channel: a WhatsApp number, an Instagram account, a Facebook Page, a website widget.
 * A business can have any number of each type, so everything downstream points at a specific row here.
 */
export type ChannelSettings = {
  /** Show customers when the team has read their message and is typing. Missing means on. */
  readReceipts?: boolean;
};

export const channelAccount = pgTable(
  "channel_account",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    type: channelType("type").notNull(),
    /** Who runs the channel: "meta" for WhatsApp, Instagram and Messenger. */
    provider: text("provider").notNull(),
    /** The provider's id used to route webhooks: WhatsApp phone number id, Page id, IG account id. */
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    /** For phone-based channels, the number as people see it. */
    displayPhone: text("display_phone"),
    status: channelStatus("status").notNull().default("active"),
    /** Access token and other secrets, encrypted with CHANNEL_SECRET_KEY (see @relay/core secrets). Never sent to the browser. */
    credentials: text("credentials").notNull(),
    /** Provider details that are not secret: WABA / messaging account id, business id, quality rating. */
    providerMeta: jsonb("provider_meta").$type<Record<string, unknown>>().notNull().default({}),
    /** Choices the business makes per channel. readReceipts (default on): blue ticks and "typing…". */
    settings: jsonb("settings").$type<ChannelSettings>().notNull().default({}),
    /** Branch that new conversations on this channel belong to. */
    defaultBranchId: text("default_branch_id").references(() => branch.id, { onDelete: "set null" }),
    /** Why the channel is in error, in the provider's words (for example an expired token). */
    statusReason: text("status_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // A number or page can be connected once in all of Relay.
    uniqueIndex("channel_account_type_external_uidx").on(t.type, t.externalId),
    index("channel_account_org_idx").on(t.organizationId),
  ],
);

/** Which branches use a channel. One number can serve several branches. */
export const channelAccountBranch = pgTable(
  "channel_account_branch",
  {
    channelAccountId: text("channel_account_id")
      .notNull()
      .references(() => channelAccount.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelAccountId, t.branchId] }),
    index("channel_account_branch_branch_idx").on(t.branchId),
  ],
);

/**
 * Every webhook payload exactly as it arrived, before any processing. Lets us replay events after a
 * bug fix instead of losing messages. Duplicate deliveries share a dedupe key and are stored once.
 */
export const webhookEvent = pgTable(
  "webhook_event",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    /** The payload's own type, for Meta the `object` field ("whatsapp_business_account", "page", "instagram"). */
    object: text("object"),
    /** sha256 of the raw body. */
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    /** No connected channel matched (for example a number that was disconnected). Kept for replay. */
    unrouted: boolean("unrouted").notNull().default(false),
  },
  (t) => [
    uniqueIndex("webhook_event_dedupe_uidx").on(t.provider, t.dedupeKey),
    index("webhook_event_unprocessed_idx").on(t.receivedAt).where(sql`${t.processedAt} is null`),
  ],
);
