/*
 * @relay/channels: every messaging channel, translated into one Relay shape.
 * The worker and API use createChannelRegistry(); storage and queues live in the API and worker.
 */
export {
  type AccountRef,
  type ChannelAdapter,
  type ChannelRegistry,
  type ConnectResult,
  createChannelRegistry,
  type GroupAdapter,
} from "./adapter";
export * from "./meta/errors";
export { createGraphClient, type GraphClient, type GraphConfig } from "./meta/graph";
export { signMetaPayload, verifyMetaHandshake, verifyMetaSignature } from "./meta/signature";
export * from "./status";
export * from "./types";
export { whatsappCapabilities } from "./whatsapp/capabilities";
export { fetchWhatsAppMedia } from "./whatsapp/media";
export { parseWhatsAppWebhook } from "./whatsapp/parse";
export {
  buildWhatsAppSendBody,
  describeWhatsAppNumber,
  markWhatsAppRead,
  sendWhatsAppMessage,
  subscribeWhatsAppAccount,
  type WhatsAppAccount,
} from "./whatsapp/send";
