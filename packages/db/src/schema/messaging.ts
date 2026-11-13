import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { branch } from "./branches";
import { channelAccount, channelType } from "./channels";
import { channelGroup } from "./groups";

/** The newest message of a conversation, as the conversation list shows it (see @relay/core inbox.ts). */
type MessagePreview = {
  type: string;
  text: string | null;
  direction: "inbound" | "outbound";
  /** Who wrote it, when that matters (group members, teammates). */
  senderName: string | null;
};

/** A customer: our own record of a person, with no channel id on it. */
export const contact = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("contact_org_idx").on(t.organizationId, t.createdAt)],
);

/**
 * One way to reach a contact on one channel. WhatsApp: the business-scoped user id (BSUID), with the
 * phone number when Meta shares it. Merging two contacts means moving identity rows; nothing else changes.
 */
export const contactIdentity = pgTable(
  "contact_identity",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    channelType: channelType("channel_type").notNull(),
    /** Where the id is valid. WhatsApp ids are scoped to a business portfolio; Page/IG ids to one account. */
    scope: text("scope").notNull(),
    externalId: text("external_id").notNull(),
    phone: text("phone"),
    username: text("username"),
    profileName: text("profile_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contact_identity_uidx").on(t.organizationId, t.channelType, t.scope, t.externalId),
    index("contact_identity_contact_idx").on(t.contactId),
    index("contact_identity_phone_idx").on(t.organizationId, t.phone),
  ],
);

export const conversationStatus = pgEnum("conversation_status", ["open", "closed"]);
/** A one-to-one chat with a customer, or a group chat (on any channel that has groups). */
export const conversationKind = pgEnum("conversation_kind", ["direct", "group"]);

/**
 * All messages on one channel account with one customer (direct) or in one group (group).
 * A direct conversation has a contact and identity; a group conversation has a group instead.
 */
export const conversation = pgTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id").references(() => branch.id, { onDelete: "set null" }),
    channelAccountId: text("channel_account_id")
      .notNull()
      .references(() => channelAccount.id, { onDelete: "cascade" }),
    kind: conversationKind("kind").notNull().default("direct"),
    contactId: text("contact_id").references(() => contact.id, { onDelete: "cascade" }),
    contactIdentityId: text("contact_identity_id").references(() => contactIdentity.id, {
      onDelete: "cascade",
    }),
    groupId: text("group_id").references(() => channelGroup.id, { onDelete: "cascade" }),
    status: conversationStatus("status").notNull().default("open"),
    /** The teammate handling it. Null: unassigned. */
    assignedUserId: text("assigned_user_id").references(() => user.id, { onDelete: "set null" }),
    /** The newest message in short form, for the conversation list. Kept current on every new message. */
    lastMessagePreview: jsonb("last_message_preview").$type<MessagePreview>(),
    lastMessageAt: timestamp("last_message_at"),
    lastInboundAt: timestamp("last_inbound_at"),
    /** End of the reply window (WhatsApp: 24 h after the customer's last message; groups: after any member's). Null when it never opened. */
    windowExpiresAt: timestamp("window_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversation_direct_uidx")
      .on(t.channelAccountId, t.contactIdentityId)
      .where(sql`${t.kind} = 'direct'`),
    uniqueIndex("conversation_group_uidx").on(t.channelAccountId, t.groupId).where(sql`${t.kind} = 'group'`),
    index("conversation_org_branch_idx").on(t.organizationId, t.branchId, t.lastMessageAt),
    index("conversation_assignee_idx").on(t.organizationId, t.assignedUserId, t.lastMessageAt),
    check(
      "conversation_kind_complete",
      sql`(${t.kind} = 'direct' and ${t.contactIdentityId} is not null and ${t.contactId} is not null) or (${t.kind} = 'group' and ${t.groupId} is not null)`,
    ),
  ],
);

export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const messageSender = pgEnum("message_sender", ["contact", "user", "bot", "ai_agent", "system"]);
/** Outbound moves forward only: queued < sending < accepted < sent < delivered < read. failed is terminal. */
export const messageStatus = pgEnum("message_status", [
  "received",
  "queued",
  "sending",
  "accepted",
  "sent",
  "delivered",
  "read",
  "failed",
]);

/**
 * A message in either direction. Outbound rows double as the outbox: their status drives sending and
 * retries, and the queue job id is the message id.
 */
export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    channelAccountId: text("channel_account_id")
      .notNull()
      .references(() => channelAccount.id, { onDelete: "cascade" }),
    direction: messageDirection("direction").notNull(),
    senderType: messageSender("sender_type").notNull(),
    senderUserId: text("sender_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Who wrote an inbound message. In a group this is the participant; in a direct chat, the customer. */
    senderIdentityId: text("sender_identity_id").references(() => contactIdentity.id, {
      onDelete: "set null",
    }),
    /** text, image, audio, video, document, sticker, location, contacts, interactive, button, reaction, order, system, unsupported */
    type: text("type").notNull(),
    /** The message in Relay's normalized shape (see @relay/channels). */
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    /** The provider's message id (WhatsApp wamid). Unique per channel, which deduplicates repeated webhooks. */
    externalId: text("external_id"),
    status: messageStatus("status").notNull(),
    /** Provider errors, kept as received. */
    error: jsonb("error").$type<Record<string, unknown>>(),
    replyToMessageId: text("reply_to_message_id"),
    /** When the customer sent it (inbound) or when we asked to send it (outbound). */
    sentAt: timestamp("sent_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    deliveredAt: timestamp("delivered_at"),
    readAt: timestamp("read_at"),
    failedAt: timestamp("failed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_account_external_uidx").on(t.channelAccountId, t.externalId),
    index("message_conversation_idx").on(t.conversationId, t.sentAt),
  ],
);

export const attachmentStatus = pgEnum("attachment_status", ["pending", "stored", "failed"]);

/** A file on a message, copied into our own storage on arrival (provider links expire). */
export const attachment = pgTable(
  "attachment",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Null while a teammate's upload waits to be sent. */
    messageId: text("message_id").references(() => message.id, { onDelete: "cascade" }),
    /** The teammate who uploaded it (outbound files only). */
    uploadedByUserId: text("uploaded_by_user_id").references(() => user.id, { onDelete: "set null" }),
    /** image, audio, video, document, sticker */
    kind: text("kind").notNull(),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    providerMediaId: text("provider_media_id"),
    /** Where the file lives in our storage, once copied. */
    storageKey: text("storage_key"),
    status: attachmentStatus("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("attachment_message_idx").on(t.messageId)],
);

/**
 * Delivery and read state per recipient, for messages sent to a group (any channel with per-participant
 * receipts). The message's own status is the furthest any recipient reached.
 */
export const messageReceipt = pgTable(
  "message_receipt",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    contactIdentityId: text("contact_identity_id")
      .notNull()
      .references(() => contactIdentity.id, { onDelete: "cascade" }),
    status: messageStatus("status").notNull(),
    deliveredAt: timestamp("delivered_at"),
    readAt: timestamp("read_at"),
    failedAt: timestamp("failed_at"),
    error: jsonb("error").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("message_receipt_uidx").on(t.messageId, t.contactIdentityId)],
);

/** When each teammate last looked at a conversation. Unread counts are per person. */
export const conversationRead = pgTable(
  "conversation_read",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at").notNull(),
  },
  (t) => [uniqueIndex("conversation_read_uidx").on(t.userId, t.conversationId)],
);
