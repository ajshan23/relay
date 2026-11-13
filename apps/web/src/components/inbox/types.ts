/** Shapes returned by /api/conversations, /api/uploads and /api/events. */

export type InboxView = "open" | "mine" | "unassigned" | "closed";

export type Preview = {
  type: string;
  text: string | null;
  direction: "inbound" | "outbound";
  senderName: string | null;
};

export type Person = { id: string; name: string; image: string | null };

export type ConversationRow = {
  id: string;
  kind: "direct" | "group";
  status: "open" | "closed";
  title: string;
  branchId: string | null;
  channelId: string;
  channelType: string;
  channelName: string;
  phone: string | null;
  groupStatus: string | null;
  participantCount: number | null;
  assignee: Person | null;
  preview: Preview | null;
  activityAt: string;
  windowExpiresAt: string | null;
  windowOpen: boolean;
  unreadCount: number;
};

export type ConversationPage = { conversations: ConversationRow[]; nextCursor: string | null };

export type Counts = { open: number; mine: number; unassigned: number; closed: number; unread: number };

export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

export type ConversationDetail = {
  conversation: {
    id: string;
    kind: "direct" | "group";
    status: "open" | "closed";
    title: string;
    createdAt: string;
    lastMessageAt: string | null;
    lastInboundAt: string | null;
    windowExpiresAt: string | null;
    windowOpen: boolean;
  };
  channel: { id: string; type: string; name: string; phone: string | null; status: string };
  capabilities: {
    replyWindowHours: number | null;
    maxTextLength: number;
    media: Record<MediaKind, { maxBytes: number; mimeTypes: string[] }>;
    outboundTypes: string[];
    reactions: boolean;
    templates: boolean;
  } | null;
  branch: { id: string; name: string } | null;
  assignee: Person | null;
  contact: {
    id: string;
    name: string | null;
    createdAt: string;
    identities: {
      id: string;
      channelType: string;
      phone: string | null;
      username: string | null;
      profileName: string | null;
    }[];
  } | null;
  group: {
    id: string;
    subject: string | null;
    description: string | null;
    status: string;
    participantCount: number;
    joinApprovalMode: string | null;
    participants: {
      identityId: string;
      name: string | null;
      phone: string | null;
      status: "active" | "left" | "removed";
      joinedAt: string | null;
      leftAt: string | null;
    }[];
  } | null;
  canWork: boolean;
};

export type MessageStatus =
  | "queued"
  | "sending"
  | "accepted"
  | "sent"
  | "delivered"
  | "read"
  | "played"
  | "failed"
  | "received";

export type Attachment = {
  id: string;
  kind: string;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  status: "pending" | "stored" | "failed";
  url: string;
};

export type Message = {
  id: string;
  direction: "inbound" | "outbound";
  senderType: string;
  sender: { kind: string; id: string | null; name: string | null };
  type: string;
  content: Record<string, unknown>;
  status: MessageStatus;
  error: { reason?: string; message?: string; errors?: { message?: string; code?: number }[] } | null;
  sentAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  attachments: Attachment[];
  reactions: { emoji: string; by: string | null }[];
  replyTo: (Preview & { id: string }) | null;
  receipts: { delivered: number; read: number } | null;
  /** Set on messages shown before the server confirmed them. */
  pending?: boolean;
};

export type MessagePage = { messages: Message[]; nextBefore: string | null };

export type Upload = {
  id: string;
  kind: MediaKind;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  url: string;
};

export type ChannelSummary = {
  id: string;
  type: string;
  displayName: string;
  displayPhone: string | null;
  status: string;
};
