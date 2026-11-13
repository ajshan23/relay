import type { TemplateLimits, TemplateStatus } from "@relay/core/templates";

/*
 * Relay's channel-agnostic shapes. Every channel adapter turns its provider's webhooks into
 * NormalizedEvent values and sends OutboundMessage values. Nothing outside an adapter ever sees a
 * provider payload.
 */

export type ChannelType = "whatsapp" | "instagram" | "messenger" | "webchat" | "sms" | "email";

/** The person on the other side, as one channel knows them. */
export type ChannelIdentity = {
  /** Stable id on this channel. WhatsApp: the business-scoped user id (BSUID) when present, else the wa_id. */
  externalId: string;
  /** Where the id is valid. WhatsApp: the business account that received the message. */
  scope: string;
  phone: string | null;
  username: string | null;
  profileName: string | null;
};

export type MediaRef = {
  /** Provider media id, used to download the file (WhatsApp ids expire after 7 days). */
  providerMediaId: string;
  mimeType: string | null;
  sha256: string | null;
  fileName: string | null;
  caption: string | null;
};

/** A message in Relay's normalized shape. Unknown parts of the provider payload are kept in `raw`. */
export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image" | "video" | "sticker"; media: MediaRef; animated?: boolean }
  | { type: "audio"; media: MediaRef; voice: boolean }
  | { type: "document"; media: MediaRef }
  | {
      type: "location";
      latitude: number;
      longitude: number;
      name: string | null;
      address: string | null;
      url: string | null;
    }
  | { type: "contacts"; contacts: Record<string, unknown>[] }
  /** A tap on a template quick-reply button. */
  | { type: "button"; payload: string; text: string }
  /** A tap on an interactive reply button or list row, a WhatsApp Flow submission, or a call permission answer. */
  | {
      type: "interactive";
      kind: "button_reply" | "list_reply";
      id: string;
      title: string;
      description: string | null;
    }
  | {
      type: "interactive";
      kind: "flow_reply";
      name: string;
      response: Record<string, unknown> | null;
      responseRaw: string;
    }
  | { type: "interactive"; kind: "call_permission_reply"; response: string; data: Record<string, unknown> }
  | {
      type: "order";
      catalogId: string | null;
      text: string | null;
      items: { productId: string; quantity: number; price: number; currency: string }[];
    }
  | { type: "unsupported"; reason: string | null };

export type ProviderError = {
  code: number;
  title: string | null;
  message: string | null;
  details: string | null;
};

/** Where a message came from, beyond its text: a reply, a forward, or a click-to-WhatsApp ad. */
export type MessageContext = {
  replyToExternalId: string | null;
  forwarded: boolean;
  frequentlyForwarded: boolean;
  referredProduct: { catalogId: string; productId: string } | null;
  adReferral: Record<string, unknown> | null;
};

type Routed = {
  channel: ChannelType;
  /** The provider id of the receiving channel account (WhatsApp phone_number_id). Routes the event. */
  accountExternalId: string;
};

/** Where a message belongs: a one-to-one chat with the sender, or a group chat. */
export type ConversationTarget = { kind: "direct" } | { kind: "group"; groupExternalId: string };

export type MessageReceived = Routed & {
  kind: "message.received";
  externalId: string;
  sentAt: Date;
  /** Who wrote it. In a group, this is the participant. */
  from: ChannelIdentity;
  conversation: ConversationTarget;
  content: MessageContent;
  context: MessageContext;
  errors: ProviderError[];
};

export type DeliveryStatus = "sent" | "delivered" | "read" | "played" | "failed";

/** Who a status is about: the customer of a direct chat, or one participant of a group. */
export type StatusRecipient =
  | { kind: "direct"; externalId: string | null }
  | { kind: "group"; groupExternalId: string; participant: ChannelIdentity | null };

export type MessageStatusEvent = Routed & {
  kind: "message.status";
  /** The provider message id of our outbound message. */
  externalId: string;
  status: DeliveryStatus;
  at: Date;
  /** Our own message id, echoed back by the provider (WhatsApp biz_opaque_callback_data). */
  ourMessageId: string | null;
  recipient: StatusRecipient;
  errors: ProviderError[];
  pricing: { category: string | null; type: string | null } | null;
};

export type ReactionEvent = Routed & {
  kind: "reaction";
  externalId: string;
  at: Date;
  from: ChannelIdentity;
  conversation: ConversationTarget;
  targetExternalId: string;
  /** Null when the reaction was removed. */
  emoji: string | null;
};

/** The customer changed their number or id; their existing identity should follow. */
export type ContactChangedEvent = Routed & {
  kind: "contact.changed";
  at: Date;
  scope: string;
  previousExternalId: string | null;
  newExternalId: string | null;
  newPhone: string | null;
  description: string | null;
};

/** Account-level news we store but do not act on yet (quality, template status, account alerts, errors). */
export type AccountEvent = Routed & {
  kind: "account.update";
  field: string;
  data: Record<string, unknown>;
  errors: ProviderError[];
};

/*
 * Group events: the same on every channel that has groups. Channels that manage groups
 * asynchronously (WhatsApp) answer our requests with these, matched by `requestId`.
 */
type GroupBase = Routed & {
  /** The channel's group id. Can be null on a failed create. */
  groupExternalId: string | null;
  /** Echo of the request that caused this, when the channel gives one. */
  requestId: string | null;
  at: Date;
};

export type GroupEvent =
  | (GroupBase & {
      kind: "group.created";
      subject: string | null;
      description: string | null;
      inviteLink: string | null;
      joinApprovalMode: string | null;
    })
  | (GroupBase & { kind: "group.failed"; operation: "create" | "update" | "delete"; errors: ProviderError[] })
  | (GroupBase & { kind: "group.deleted" })
  | (GroupBase & {
      kind: "group.updated";
      /** Only the parts that changed successfully are set. */
      subject?: string;
      description?: string;
      iconChanged?: boolean;
      errors: ProviderError[];
    })
  | (GroupBase & { kind: "group.suspended" })
  | (GroupBase & { kind: "group.restored" })
  | (GroupBase & { kind: "group.participants_added"; participants: ChannelIdentity[]; reason: string | null })
  | (GroupBase & {
      kind: "group.participants_removed";
      participants: ChannelIdentity[];
      /** "participant" when they left on their own; "business" when we removed them. */
      initiatedBy: "business" | "participant" | null;
      failed: { participant: ChannelIdentity; errors: ProviderError[] }[];
    })
  | (GroupBase & { kind: "group.join_requested"; requestExternalId: string; participant: ChannelIdentity })
  | (GroupBase & {
      kind: "group.join_request_withdrawn";
      requestExternalId: string;
      participant: ChannelIdentity;
    });

/** A channel's review of a template changed (approved, needs changes, paused…). */
export type TemplateStatusEvent = {
  channel: ChannelType;
  kind: "template.status_changed";
  /** The provider's template id. Routes the event to the template's channel copies. */
  templateExternalId: string;
  status: TemplateStatus;
  /** The reviewer's reason, in plain words, when there is one. */
  reason: string | null;
  at: Date;
};

export type NormalizedEvent =
  | MessageReceived
  | MessageStatusEvent
  | ReactionEvent
  | ContactChangedEvent
  | AccountEvent
  | GroupEvent
  | TemplateStatusEvent;

/** Who a message goes to: one customer (by phone or channel id), or a group. */
export type Recipient =
  | { kind: "direct"; phone: string | null; userId: string | null }
  | { kind: "group"; groupExternalId: string };

/** What Relay asks a channel to send. */
export type OutboundMessage = (
  | { type: "text"; text: string; previewUrl?: boolean }
  | {
      type: "template";
      /** The channel-safe template name and language it was published under. */
      name: string;
      language: string;
      /** Detail values by name. */
      values: Record<string, string>;
      /** For templates with a picture, video or file header: the file handed to the channel. */
      headerMedia?: { kind: "image" | "video" | "document"; providerMediaId: string; fileName?: string };
    }
  | {
      type: "image" | "video" | "audio" | "document" | "sticker";
      providerMediaId: string;
      caption?: string;
      fileName?: string;
    }
) & {
  /** Provider id of the message being replied to. */
  replyToExternalId?: string;
};

/** Channel rules the inbox, flows and campaigns read instead of checking the channel type. */
export type ChannelCapabilities = {
  /** Hours after the customer's last message during which free-form replies are allowed. Null: no window. */
  replyWindowHours: number | null;
  /** Outside the window, only pre-approved templates can be sent. */
  templatesOutsideWindow: boolean;
  maxReplyButtons: number;
  maxListRows: number;
  maxTextLength: number;
  /** File kinds this channel sends, with the size limit and accepted types of each. */
  media: Record<
    "image" | "video" | "audio" | "document" | "sticker",
    { maxBytes: number; mimeTypes: string[] }
  >;
  readReceipts: boolean;
  typingIndicator: boolean;
  reactions: boolean;
  /** What this channel's group chats can do, or null when the channel has no groups. */
  groups: GroupCapabilities | null;
  /** What this channel's message templates can hold, or null when it has none. */
  templates: TemplateLimits | null;
};

export type GroupCapabilities = {
  /** The business can create groups through the channel. */
  canCreate: boolean;
  /** How people get in: by an invite link, by being added directly, or either. */
  joinBy: "invite_link" | "direct_add" | "both";
  /** Joining can require approval. */
  joinRequests: boolean;
  canRemoveParticipants: boolean;
  canRename: boolean;
  maxParticipants: number | null;
  /** Message types the business can send into a group. */
  outboundTypes: OutboundMessage["type"][];
  /** Delivered/read is reported per participant. */
  perParticipantReceipts: boolean;
  /** Hours a group stays open for free-form replies after any member writes. Null: no window. */
  replyWindowHours: number | null;
};
