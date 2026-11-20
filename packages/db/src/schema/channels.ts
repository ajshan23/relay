import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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
/** setting_up: connected through Embedded Signup but a Meta step (webhooks) is not finished yet. */
export const channelStatus = pgEnum("channel_status", ["active", "disconnected", "error", "setting_up"]);

/**
 * One connected channel: a WhatsApp number, an Instagram account, a Facebook Page, a website widget.
 * A business can have any number of each type, so everything downstream points at a specific row here.
 */
export type ChannelSettings = {
  /** Show customers when the team has read their message and is typing. Missing means on. */
  readReceipts?: boolean;
};

/** One coexistence sync (phone-app contacts or chat history) and how far it got. */
export type CoexistenceSync = {
  status: "pending" | "requested" | "importing" | "done" | "declined" | "expired" | "failed";
  requestId?: string | null;
  requestedAt?: string;
  progress?: number;
  imported?: number;
  error?: string | null;
  updatedAt?: string;
};

/** What Relay keeps about a WhatsApp number (channel_account.provider_meta). Nothing here is secret. */
export type WhatsAppProviderMeta = {
  /** The WhatsApp business (messaging) account id. */
  wabaId?: string;
  /** The business portfolio id. WhatsApp user ids (BSUIDs) are scoped to it. */
  businessId?: string | null;
  verifiedName?: string;
  qualityRating?: string;
  messagingLimit?: string;
  nameStatus?: string;
  /** The business username, once claimed. */
  username?: string | null;
  healthAt?: string;
  onboarding?: {
    method: "embedded_signup" | "manual";
    version?: string;
    coexistence: boolean;
    attemptId?: string;
    onboardedAt: string;
    /** When the business token stops working; null means it does not expire. */
    tokenExpiresAt?: string | null;
    subscribedFields?: string[];
  };
  registration?: { status: "registered" | "not_needed" | "skipped" | "failed"; at: string; error?: string };
  coexistence?: { windowEndsAt: string; contacts: CoexistenceSync; history: CoexistenceSync };
  /** Last time an account_update arrived, in Meta's words. */
  accountEvent?: { event: string; at: string; detail?: string };
  fake?: boolean;
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
    /** The one branch this number belongs to: its chats, contacts and people are that branch's. */
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    /** Why the channel is in error, in the provider's words (for example an expired token). */
    statusReason: text("status_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // A number or page can be connected once in all of Relay.
    uniqueIndex("channel_account_type_external_uidx").on(t.type, t.externalId),
    index("channel_account_org_idx").on(t.organizationId),
    index("channel_account_branch_idx").on(t.branchId),
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

/**
 * One run of Meta's Embedded Signup, keyed by an id the browser makes before opening the popup. Makes
 * a retried request safe (the same attempt never connects twice) and lets the browser ask "did it
 * finish?" after a dropped response, since the popup's code works only once.
 */
export const onboardingAttempt = pgTable(
  "onboarding_attempt",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id").references(() => branch.id, { onDelete: "set null" }),
    userId: text("user_id"),
    /** running → done | failed. */
    status: text("status").notNull().default("running"),
    /** The step reached: exchange, grants, number, save, subscribe, register, sync. */
    step: text("step").notNull().default("start"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    channelAccountId: text("channel_account_id").references(() => channelAccount.id, {
      onDelete: "set null",
    }),
    /** What the popup said (event, ids), for support. Never the code or token. */
    session: jsonb("session").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("onboarding_attempt_org_idx").on(t.organizationId, t.createdAt)],
);
