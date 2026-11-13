import {
  type AccountRef,
  type ChannelRegistry,
  createChannelRegistry,
  GraphError,
  GraphUncertainError,
} from "@relay/channels";
import { decryptSecretJson, env } from "@relay/core";
import type { schema } from "@relay/db";
import type { Context } from "hono";
import { fail } from "./modules/branches/access";

/*
 * The API's channel registry: routes reach channels only through adapters, never a provider directly.
 */

let registry: ChannelRegistry | undefined;

export function channels(): ChannelRegistry {
  if (!registry) {
    const config = env();
    registry = createChannelRegistry({
      meta: { baseUrl: config.META_GRAPH_URL, version: config.META_GRAPH_VERSION, timeoutMs: 15_000 },
    });
  }
  return registry;
}

/** A stored channel account with its secrets decrypted, as adapters take it. */
export function accountRef(account: typeof schema.channelAccount.$inferSelect): AccountRef {
  return {
    externalId: account.externalId,
    credentials: decryptSecretJson(account.credentials, env().CHANNEL_SECRET_KEY ?? ""),
    providerMeta: account.providerMeta,
  };
}

/** Turns a channel provider error into a plain API answer; returns null for other errors. */
export function providerFailure(c: Context, err: unknown) {
  if (err instanceof GraphError) {
    if (err.kind === "authFailed") return fail(c, 401, "channel_token_rejected", err.message);
    if (err.kind === "rateLimited") return fail(c, 429, "channel_rate_limited", err.message);
    return fail(c, 422, "channel_rejected", err.message);
  }
  if (err instanceof GraphUncertainError) return fail(c, 504, "channel_unreachable", err.message);
  return null;
}
