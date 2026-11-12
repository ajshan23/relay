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

export type MessageReceived = Routed & {
  kind: "message.received";
  externalId: string;
  sentAt: Date;
  from: ChannelIdentity;
  content: MessageContent;
  context: MessageContext;
  errors: ProviderError[];
  /** Group chats carry a group id; one-to-one chats do not. */
  groupId: string | null;
};

export type DeliveryStatus = "sent" | "delivered" | "read" | "played" | "failed";

export type MessageStatusEvent = Routed & {
  kind: "message.status";
  /** The provider message id of our outbound message. */
  externalId: string;
  status: DeliveryStatus;
  at: Date;
  /** Our own message id, echoed back by the provider (WhatsApp biz_opaque_callback_data). */
  ourMessageId: string | null;
  recipientExternalId: string | null;
  errors: ProviderError[];
  pricing: { category: string | null; type: string | null } | null;
};

export type ReactionEvent = Routed & {
  kind: "reaction";
  externalId: string;
  at: Date;
  from: ChannelIdentity;
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

export type NormalizedEvent =
  | MessageReceived
  | MessageStatusEvent
  | ReactionEvent
  | ContactChangedEvent
  | AccountEvent;

/** What Relay asks a channel to send. */
export type OutboundMessage = (
  | { type: "text"; text: string; previewUrl?: boolean }
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
  media: Record<"image" | "video" | "audio" | "document" | "sticker", { maxBytes: number }>;
  readReceipts: boolean;
  typingIndicator: boolean;
  reactions: boolean;
};
