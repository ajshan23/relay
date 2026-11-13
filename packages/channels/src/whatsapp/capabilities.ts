import type { ChannelCapabilities } from "../types";

const MB = 1024 * 1024;

/** WhatsApp Cloud API rules, from research/01-whatsapp-cloud-api.md. */
export const whatsappCapabilities: ChannelCapabilities = {
  replyWindowHours: 24,
  templatesOutsideWindow: true,
  maxReplyButtons: 3,
  maxListRows: 10,
  maxTextLength: 4096,
  media: {
    image: { maxBytes: 5 * MB },
    video: { maxBytes: 16 * MB },
    audio: { maxBytes: 16 * MB },
    document: { maxBytes: 100 * MB },
    sticker: { maxBytes: 500 * 1024 },
  },
  readReceipts: true,
  typingIndicator: true,
  reactions: true,
  // WhatsApp Groups API: Official Business Account numbers only; business-created, invite-link only.
  groups: {
    canCreate: true,
    joinBy: "invite_link",
    joinRequests: true,
    canRemoveParticipants: true,
    canRename: true,
    maxParticipants: 8,
    outboundTypes: ["text", "image", "video", "audio", "document"],
    perParticipantReceipts: true,
    // Meta does not document the group window length; 24 h assumed until confirmed on a live group.
    replyWindowHours: 24,
  },
};
