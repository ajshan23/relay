import { sql } from "drizzle-orm";
import {
  bigint,
  check,
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
    /**
     * Main phone number, digits only with no "+" (as WhatsApp sends it). Set for contacts added by hand or
     * imported; when someone with this number first writes in, their channel identity joins this contact.
     */
    phone: text("phone"),
    email: text("email"),
    /** Home branch, used as a filter (contacts belong to the business). */
    /** Contacts belong to one branch: the same person in two branches is two contacts. */
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    /**
     * The business's own fields, keyed by contact_field.key, in their real JSON types (numbers, booleans,
     * ISO dates, arrays for multiple choice). Validated against the field type on every write.
     */
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    /** Ids of rows in `tag`. Kept on the contact for one-row reads; GIN-indexed for filters. */
    tagIds: text("tag_ids").array().notNull().default(sql`'{}'::text[]`),
    /** How the contact arrived: channel (they wrote first), manual, import. */
    source: text("source").notNull().default("channel"),
    /** Newest message in any of their conversations, kept current by the worker. */
    lastMessageAt: timestamp("last_message_at"),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("contact_org_idx").on(t.organizationId, t.createdAt),
    // The contacts table is always one branch, sorted newest first with id as the tie-breaker.
    index("contact_branch_last_message_idx").on(t.branchId, t.lastMessageAt.desc().nullsLast(), t.id.desc()),
    index("contact_branch_created_idx").on(t.branchId, t.createdAt.desc(), t.id.desc()),
    index("contact_branch_phone_idx").on(t.branchId, t.phone),
    index("contact_branch_email_idx").on(t.branchId, t.email),
    index("contact_phone_trgm").using("gin", sql`${t.phone} gin_trgm_ops`),
    index("contact_attributes_gin").using("gin", sql`${t.attributes} jsonb_path_ops`),
    index("contact_tags_gin").using("gin", t.tagIds),
    index("contact_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
    index("contact_email_trgm").using("gin", sql`${t.email} gin_trgm_ops`),
  ],
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
    /** The contact's branch: one customer id can belong to a contact in each branch. */
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
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
    uniqueIndex("contact_identity_uidx").on(
      t.organizationId,
      t.branchId,
      t.channelType,
      t.scope,
      t.externalId,
    ),
    index("contact_identity_contact_idx").on(t.contactId),
    index("contact_identity_phone_idx").on(t.branchId, t.phone),
    index("contact_identity_phone_trgm").using("gin", sql`${t.phone} gin_trgm_ops`),
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
    /** Hidden from the open lists until then; a customer message or the time passing wakes it. */
    snoozedUntil: timestamp("snoozed_until"),
    snoozedByUserId: text("snoozed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    /** The last customer message marked read at the channel (blue ticks), so each is sent once. */
    providerReadMessageId: text("provider_read_message_id"),
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
  /** A voice note's first play (WhatsApp, since March 2026). */
  "played",
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
    /** Sent by a broadcast (see broadcasts.ts). No foreign key: broadcasts.ts imports this file. */
    broadcastId: text("broadcast_id"),
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
    index("message_broadcast_idx").on(t.broadcastId),
    // Search inside a conversation: message text and media captions.
    index("message_text_trgm").using(
      "gin",
      sql`(coalesce(${t.content} ->> 'text', '') || ' ' || coalesce(${t.content} -> 'media' ->> 'caption', '')) gin_trgm_ops`,
    ),
  ],
);

/** A teammate @mentioned in an internal note. Read when they open the conversation. */
export const mention = pgTable(
  "mention",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    byUserId: text("by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    readAt: timestamp("read_at"),
  },
  (t) => [
    index("mention_user_unread_idx").on(t.userId, t.readAt),
    index("mention_conversation_idx").on(t.conversationId, t.userId),
  ],
);

/**
 * A file's bytes, stored once per business however many messages, templates or broadcasts use it
 * (same content, same row). Key: files/<org>/<sha256>.
 */
export const storedFile = pgTable(
  "stored_file",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Hex SHA-256 of the bytes. */
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: text("mime_type"),
    storageKey: text("storage_key").notNull(),
    /**
     * A small WebP preview (480 px wide) for images and videos, shown in the chat so opening a
     * conversation doesn't download every file in full. Null until made, or when it can't be.
     */
    previewKey: text("preview_key"),
    width: integer("width"),
    height: integer("height"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** Last time something new pointed at it; the orphan sweep keeps recent files. */
    lastUsedAt: timestamp("last_used_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("stored_file_org_sha_uidx").on(t.organizationId, t.sha256)],
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
    /** The stored bytes (shared with every other use of the same file). */
    fileId: text("file_id").references(() => storedFile.id, { onDelete: "set null" }),
    /** Where the file lived before stored_file (older rows); new rows use fileId. */
    storageKey: text("storage_key"),
    status: attachmentStatus("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("attachment_message_idx").on(t.messageId), index("attachment_file_idx").on(t.fileId)],
);

/**
 * A stored file uploaded to a channel number (WhatsApp media id), reused for every send from that
 * number while it's valid (WhatsApp keeps media 30 days). A broadcast uploads its file once per number.
 */
export const providerMedia = pgTable(
  "provider_media",
  {
    fileId: text("file_id")
      .notNull()
      .references(() => storedFile.id, { onDelete: "cascade" }),
    channelAccountId: text("channel_account_id")
      .notNull()
      .references(() => channelAccount.id, { onDelete: "cascade" }),
    providerMediaId: text("provider_media_id").notNull(),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.channelAccountId] })],
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
