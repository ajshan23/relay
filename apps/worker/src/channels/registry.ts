import { type AccountRef, type ChannelRegistry, createChannelRegistry } from "@relay/channels";
import { decryptSecretJson, env } from "@relay/core";
import type { schema } from "@relay/db";

/*
 * The worker's one channel registry. Everything here reaches a channel through its adapter, so the
 * worker never needs to know which channels exist.
 */

let registry: ChannelRegistry | undefined;

export function channels(): ChannelRegistry {
  if (!registry) {
    const config = env();
    registry = createChannelRegistry({
      meta: {
        baseUrl: config.META_GRAPH_URL,
        version: config.META_GRAPH_VERSION,
        timeoutMs: config.META_GRAPH_TIMEOUT_MS,
        appId: config.META_APP_ID,
      },
    });
  }
  return registry;
}

/** A stored channel account, with its secrets decrypted, as adapters take it. */
export function accountRef(account: typeof schema.channelAccount.$inferSelect): AccountRef {
  return {
    externalId: account.externalId,
    credentials: decryptSecretJson(account.credentials, env().CHANNEL_SECRET_KEY ?? ""),
    providerMeta: account.providerMeta,
  };
}
