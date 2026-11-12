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
};
