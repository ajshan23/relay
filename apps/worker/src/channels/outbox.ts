import {
  createGraphClient,
  GraphError,
  GraphUncertainError,
  type OutboundMessage,
  sendWhatsAppMessage,
  type WhatsAppAccount,
} from "@relay/channels";
import { decryptSecretJson, env } from "@relay/core";
import { and, type createDb, eq, inArray, schema, sql } from "@relay/db";
import { DelayedError, type Job, UnrecoverableError } from "bullmq";
import type { Redis } from "ioredis";

type Db = ReturnType<typeof createDb>["db"];
export type OutboxJob = { messageId: string };

/** Messages per second per number. WhatsApp's default throughput is 80; stay just under. */
const PER_NUMBER_PER_SECOND = 70;

/*
 * Sends one outbound message. The message row is the source of truth:
 *   queued/sending -> accepted (Meta took it) -> sent/delivered/read (from status webhooks)
 * Retries only when Meta said so or the request never left; a request that may have gone through
 * (timeout) is marked failed instead of resent, because a duplicate message is worse than a missing one.
 */
export function createOutboxProcessor({ db, redis }: { db: Db; redis: Redis }) {
  const config = env();
  const graph = createGraphClient({
    baseUrl: config.META_GRAPH_URL,
    version: config.META_GRAPH_VERSION,
    timeoutMs: config.META_GRAPH_TIMEOUT_MS,
  });

  async function fail(messageId: string, error: Record<string, unknown>) {
    await db
      .update(schema.message)
      .set({ status: "failed", failedAt: new Date(), error })
      .where(and(eq(schema.message.id, messageId), inArray(schema.message.status, ["queued", "sending"])));
  }

  /** Delays the job by a second when this number is over its per-second budget. */
  async function throttle(job: Job<OutboxJob>, accountId: string, token?: string) {
    const key = `rate:send:${accountId}:${Math.floor(Date.now() / 1000)}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, 2);
    if (used > PER_NUMBER_PER_SECOND && token) {
      await job.moveToDelayed(Date.now() + 1000, token);
      throw new DelayedError();
    }
  }

  return async function sendOutbound(job: Job<OutboxJob>, token?: string) {
    const [row] = await db
      .select({
        message: schema.message,
        account: schema.channelAccount,
        identity: schema.contactIdentity,
        windowExpiresAt: schema.conversation.windowExpiresAt,
      })
      .from(schema.message)
      .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.message.channelAccountId))
      .innerJoin(schema.contactIdentity, eq(schema.contactIdentity.id, schema.conversation.contactIdentityId))
      .where(eq(schema.message.id, job.data.messageId))
      .limit(1);
    if (!row) return;
    const { message, account, identity } = row;
    if (message.status !== "queued" && message.status !== "sending") return; // Already sent or given up.

    if (account.status !== "active") {
      await fail(message.id, { reason: "channel_unavailable", message: `The channel is ${account.status}` });
      throw new UnrecoverableError("channel not active");
    }
    if (!row.windowExpiresAt || row.windowExpiresAt <= new Date()) {
      await fail(message.id, {
        reason: "window_closed",
        message: "The 24-hour reply window closed before the message was sent",
      });
      throw new UnrecoverableError("window closed");
    }
    if (account.type !== "whatsapp") {
      await fail(message.id, {
        reason: "unsupported_channel",
        message: `Sending on ${account.type} is not built yet`,
      });
      throw new UnrecoverableError("unsupported channel");
    }

    await throttle(job, account.id, token);
    await db.update(schema.message).set({ status: "sending" }).where(eq(schema.message.id, message.id));

    const content = message.content as { type: string; text?: string };
    let replyToExternalId: string | undefined;
    if (message.replyToMessageId) {
      const [target] = await db
        .select({ externalId: schema.message.externalId })
        .from(schema.message)
        .where(eq(schema.message.id, message.replyToMessageId))
        .limit(1);
      replyToExternalId = target?.externalId ?? undefined;
    }
    const outbound: OutboundMessage = { type: "text", text: content.text ?? "", replyToExternalId };
    const credentials = decryptSecretJson<{ accessToken: string }>(
      account.credentials,
      config.CHANNEL_SECRET_KEY ?? "",
    );
    const waAccount: WhatsAppAccount = {
      phoneNumberId: account.externalId,
      accessToken: credentials.accessToken,
    };

    try {
      const { externalId } = await sendWhatsAppMessage(
        graph,
        waAccount,
        { phone: identity.phone, userId: identity.externalId.includes(".") ? identity.externalId : null },
        outbound,
        message.id,
      );
      // A status webhook may already have moved it further; only step up from queued/sending.
      await db
        .update(schema.message)
        .set({
          externalId: sql`coalesce(${schema.message.externalId}, ${externalId})`,
          status: sql`case when ${schema.message.status} in ('queued', 'sending') then 'accepted'::message_status else ${schema.message.status} end`,
          acceptedAt: new Date(),
          error: null,
        })
        .where(eq(schema.message.id, message.id));
    } catch (err) {
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (err instanceof GraphUncertainError) {
        await fail(message.id, {
          reason: "unknown",
          message: `${err.message}. It may or may not have been delivered, so it was not resent.`,
        });
        throw new UnrecoverableError(err.message);
      }
      if (err instanceof GraphError) {
        const detail = {
          reason: err.kind,
          code: err.code ?? null,
          message: err.message,
          details: err.details ?? null,
        };
        if (err.kind === "authFailed") {
          await db
            .update(schema.channelAccount)
            .set({ status: "error", statusReason: err.message, updatedAt: new Date() })
            .where(eq(schema.channelAccount.id, account.id));
        }
        if (err.kind === "retryable" || err.kind === "rateLimited") {
          if (lastAttempt) await fail(message.id, detail);
          else
            await db
              .update(schema.message)
              .set({ status: "queued", error: detail })
              .where(eq(schema.message.id, message.id));
          throw err;
        }
        await fail(message.id, detail);
        throw new UnrecoverableError(err.message);
      }
      if (lastAttempt)
        await fail(message.id, {
          reason: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      throw err;
    }
  };
}
