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
    image: { maxBytes: 5 * MB, mimeTypes: ["image/jpeg", "image/png"] },
    video: { maxBytes: 16 * MB, mimeTypes: ["video/mp4", "video/3gpp"] },
    audio: {
      maxBytes: 16 * MB,
      mimeTypes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"],
    },
    document: {
      maxBytes: 100 * MB,
      mimeTypes: [
        "application/pdf",
        "text/plain",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
    },
    sticker: { maxBytes: 500 * 1024, mimeTypes: ["image/webp"] },
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
  // Message templates: reviewed by Meta, usually within minutes, at most about a day.
  templates: {
    requiresApproval: true,
    reviewEstimate: "up to 2 hours",
    purposes: ["updates", "marketing", "login"],
    headerKinds: ["text", "image", "video", "document"],
    buttonKinds: ["reply", "link", "call"],
    maxButtons: 3,
    maxBodyLength: 1024,
    maxHeaderTextLength: 60,
    maxFooterLength: 60,
    maxButtonTextLength: 25,
    editNote:
      "WhatsApp reviews every change again, and an approved template can be changed about once a day.",
  },
};
