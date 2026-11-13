import { createGraphClient, type GraphConfig } from "./meta/graph";
import type {
  ChannelCapabilities,
  ChannelIdentity,
  ChannelType,
  NormalizedEvent,
  OutboundMessage,
  Recipient,
} from "./types";
import { whatsappCapabilities } from "./whatsapp/capabilities";
import {
  createWhatsAppGroup,
  decideWhatsAppJoinRequests,
  deleteWhatsAppGroup,
  getWhatsAppInviteLink,
  listWhatsAppJoinRequests,
  removeWhatsAppParticipants,
  updateWhatsAppGroup,
} from "./whatsapp/groups";
import { fetchWhatsAppMedia, uploadWhatsAppMedia } from "./whatsapp/media";
import { parseWhatsAppWebhook } from "./whatsapp/parse";
import {
  describeWhatsAppNumber,
  markWhatsAppRead,
  sendWhatsAppMessage,
  subscribeWhatsAppAccount,
} from "./whatsapp/send";

/*
 * Every channel is an adapter with the same shape. The worker and the API only talk to adapters,
 * never to a provider directly, so adding Instagram, Messenger, RCS or SMS means writing one
 * adapter and registering it here. Group chats are an optional part: channels without groups
 * leave it out (and say so in capabilities.groups).
 */

/** A connected channel account, as an adapter needs it: its provider id, secrets and stored details. */
export type AccountRef = {
  externalId: string;
  credentials: { accessToken: string } & Record<string, unknown>;
  providerMeta: Record<string, unknown>;
};

export type ConnectResult = {
  displayName: string;
  displayPhone: string | null;
  providerMeta: Record<string, unknown>;
};

export type GroupAdapter = {
  /** Starts creating a group. Asynchronous channels return a request id and confirm by webhook. */
  create(
    account: AccountRef,
    input: { subject: string; description?: string; joinApproval?: boolean },
  ): Promise<{ requestId: string | null; groupExternalId?: string }>;
  update(
    account: AccountRef,
    groupExternalId: string,
    input: { subject?: string; description?: string },
  ): Promise<{ requestId: string | null }>;
  delete(account: AccountRef, groupExternalId: string): Promise<{ requestId: string | null }>;
  /** Present when people join by link. */
  inviteLink?(account: AccountRef, groupExternalId: string, reset?: boolean): Promise<string | null>;
  /** Present when the business can add people directly. */
  addParticipants?(account: AccountRef, groupExternalId: string, people: ChannelIdentity[]): Promise<void>;
  removeParticipants?(account: AccountRef, groupExternalId: string, people: ChannelIdentity[]): Promise<void>;
  listJoinRequests?(
    account: AccountRef,
    groupExternalId: string,
  ): Promise<{ requestExternalId: string; participant: ChannelIdentity }[]>;
  decideJoinRequests?(
    account: AccountRef,
    groupExternalId: string,
    requestExternalIds: string[],
    approve: boolean,
  ): Promise<void>;
};

export type ChannelAdapter = {
  type: ChannelType;
  capabilities: ChannelCapabilities;
  /** Turns a stored webhook payload into Relay events. Returns [] for payloads of other products. */
  parseWebhook(payload: unknown): NormalizedEvent[];
  /** Checks credentials and subscribes the account to webhooks. Throws when the channel refuses. */
  connect(input: {
    externalId: string;
    credentials: AccountRef["credentials"];
    providerMeta: Record<string, unknown>;
  }): Promise<ConnectResult>;
  send(
    account: AccountRef,
    to: Recipient,
    message: OutboundMessage,
    ourMessageId: string,
  ): Promise<{ externalId: string }>;
  fetchMedia(
    account: AccountRef,
    mediaId: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; mimeType: string | null; sha256: string | null }>;
  /** Hands a file to the channel before sending it. Returns the id the send call uses. */
  uploadMedia(
    account: AccountRef,
    file: { bytes: Uint8Array; mimeType: string; fileName: string },
  ): Promise<{ providerMediaId: string }>;
  markRead?(account: AccountRef, externalId: string): Promise<void>;
  groups?: GroupAdapter;
};

/** Identity → the reference the provider wants (WhatsApp: BSUID when known, otherwise phone). */
const waPerson = (p: ChannelIdentity) => ({
  userId: p.externalId.includes(".") ? p.externalId : null,
  phone: p.phone,
});

function whatsappAdapter(graphConfig: GraphConfig): ChannelAdapter {
  const graph = createGraphClient(graphConfig);
  const wa = (a: AccountRef) => ({ phoneNumberId: a.externalId, accessToken: a.credentials.accessToken });
  return {
    type: "whatsapp",
    capabilities: whatsappCapabilities,
    parseWebhook: parseWhatsAppWebhook,
    async connect({ externalId, credentials, providerMeta }) {
      const account = { phoneNumberId: externalId, accessToken: credentials.accessToken };
      const number = await describeWhatsAppNumber(graph, account);
      const wabaId = String(providerMeta.wabaId ?? "");
      if (wabaId) await subscribeWhatsAppAccount(graph, wabaId, credentials.accessToken);
      return {
        displayName: number.verified_name ?? number.display_phone_number ?? "WhatsApp",
        displayPhone: number.display_phone_number ?? null,
        providerMeta: {
          ...providerMeta,
          verifiedName: number.verified_name ?? null,
          qualityRating: number.quality_rating ?? null,
        },
      };
    },
    send: (account, to, message, ourMessageId) =>
      sendWhatsAppMessage(graph, wa(account), to, message, ourMessageId),
    fetchMedia: (account, mediaId, maxBytes) => fetchWhatsAppMedia(graph, wa(account), mediaId, maxBytes),
    uploadMedia: (account, file) => uploadWhatsAppMedia(graph, wa(account), file),
    markRead: (account, externalId) => markWhatsAppRead(graph, wa(account), externalId),
    groups: {
      create: (account, input) => createWhatsAppGroup(graph, wa(account), input),
      update: (account, groupId, input) => updateWhatsAppGroup(graph, wa(account), groupId, input),
      delete: (account, groupId) => deleteWhatsAppGroup(graph, wa(account), groupId),
      inviteLink: (account, groupId, reset) => getWhatsAppInviteLink(graph, wa(account), groupId, reset),
      removeParticipants: (account, groupId, people) =>
        removeWhatsAppParticipants(graph, wa(account), groupId, people.map(waPerson)),
      async listJoinRequests(account, groupId) {
        const scope = String(account.providerMeta.wabaId ?? "");
        const rows = await listWhatsAppJoinRequests(graph, wa(account), groupId);
        return rows.map((r) => ({
          requestExternalId: r.join_request_id,
          participant: {
            externalId: r.user_id,
            scope,
            phone: r.wa_id ?? null,
            username: r.username ?? null,
            profileName: null,
          },
        }));
      },
      decideJoinRequests: (account, groupId, ids, approve) =>
        decideWhatsAppJoinRequests(graph, wa(account), groupId, ids, approve),
    },
  };
}

export type ChannelRegistry = {
  get(type: ChannelType): ChannelAdapter | null;
  /** Parses a stored webhook with whichever adapter understands it. */
  parse(provider: string, payload: unknown): NormalizedEvent[];
};

/** All channel adapters Relay has. Instagram, Messenger, web chat and others are added here. */
export function createChannelRegistry(config: { meta: GraphConfig }): ChannelRegistry {
  const adapters: Partial<Record<ChannelType, ChannelAdapter>> = {
    whatsapp: whatsappAdapter(config.meta),
  };
  const byMetaObject: Record<string, ChannelType> = { whatsapp_business_account: "whatsapp" };
  return {
    get: (type) => adapters[type] ?? null,
    parse(provider, payload) {
      if (provider !== "meta") return [];
      const object = (payload as { object?: string } | null)?.object ?? "";
      const type = byMetaObject[object];
      return type ? (adapters[type]?.parseWebhook(payload) ?? []) : [];
    },
  };
}
