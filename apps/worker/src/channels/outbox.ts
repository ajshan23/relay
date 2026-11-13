import {
  type ChannelAdapter,
  GraphError,
  GraphUncertainError,
  type OutboundMessage,
  type Recipient,
} from "@relay/channels";
import { env, localFileStorage, publishInboxEvent } from "@relay/core";
import { and, type createDb, eq, inArray, schema, sql } from "@relay/db";
import { DelayedError, type Job, UnrecoverableError } from "bullmq";
import type { Redis } from "ioredis";
import { accountRef, channels } from "./registry";

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
const mediaTypes = new Set(["image", "video", "audio", "document", "sticker"]);

export function createOutboxProcessor({ db, redis }: { db: Db; redis: Redis }) {
  const storage = localFileStorage(env().MEDIA_DIR);

  /** The file of an outbound media message, handed to the channel once (the id is kept for retries). */
  async function providerMediaFor(
    messageId: string,
    adapter: ChannelAdapter,
    account: typeof schema.channelAccount.$inferSelect,
  ) {
    const [file] = await db
      .select()
      .from(schema.attachment)
      .where(eq(schema.attachment.messageId, messageId))
      .limit(1);
    if (!file?.storageKey) throw new UnrecoverableError("the file of this message is missing");
    if (file.providerMediaId) return { id: file.providerMediaId, file };
    try {
      const { providerMediaId } = await adapter.uploadMedia(accountRef(account), {
        bytes: await storage.get(file.storageKey),
        mimeType: file.mimeType ?? "application/octet-stream",
        fileName: file.fileName ?? `${file.id}`,
      });
      await db.update(schema.attachment).set({ providerMediaId }).where(eq(schema.attachment.id, file.id));
      return { id: providerMediaId, file };
    } catch (err) {
      // An upload never reaches the customer, so an unanswered one is safe to retry.
      if (err instanceof GraphUncertainError) throw new Error(err.message);
      throw err;
    }
  }

  async function fail(messageId: string, error: Record<string, unknown>) {
    await db
      .update(schema.message)
      .set({ status: "failed", failedAt: new Date(), error })
      .where(and(eq(schema.message.id, messageId), inArray(schema.message.status, ["queued", "sending"])));
  }

  /**
   * Records that the channel accepted the message. Must never cause a resend: if saving fails it is
   * retried here, and if it still fails the job stops; the channel's status webhooks (which carry our
   * message id) fill the result in later.
   */
  async function recordAccepted(messageId: string, externalId: string) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // A status webhook may already have moved it further; only step up from queued/sending.
        await db
          .update(schema.message)
          .set({
            externalId: sql`coalesce(${schema.message.externalId}, ${externalId})`,
            status: sql`case when ${schema.message.status} in ('queued', 'sending') then 'accepted'::message_status else ${schema.message.status} end`,
            acceptedAt: new Date(),
            error: null,
          })
          .where(eq(schema.message.id, messageId));
        return;
      } catch (err) {
        if (attempt === 3) {
          console.error(`[outbox] ${messageId} was accepted as ${externalId} but could not be recorded`, err);
          throw new UnrecoverableError("sent, but the result could not be recorded");
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
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

  /** Tells open inboxes the message changed (accepted, failed). */
  async function announce(messageId: string) {
    const [row] = await db
      .select({
        conversationId: schema.message.conversationId,
        organizationId: schema.conversation.organizationId,
        branchId: schema.conversation.branchId,
      })
      .from(schema.message)
      .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
      .where(eq(schema.message.id, messageId))
      .limit(1);
    if (row)
      await publishInboxEvent(redis, row.organizationId, {
        type: "message.updated",
        conversationId: row.conversationId,
        branchId: row.branchId,
        messageId,
      });
  }

  return async function sendAndAnnounce(job: Job<OutboxJob>, token?: string) {
    try {
      return await sendOutbound(job, token);
    } finally {
      await announce(job.data.messageId);
    }
  };

  async function sendOutbound(job: Job<OutboxJob>, token?: string) {
    const [row] = await db
      .select({
        message: schema.message,
        account: schema.channelAccount,
        conversation: schema.conversation,
        identity: schema.contactIdentity,
        group: schema.channelGroup,
      })
      .from(schema.message)
      .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.message.channelAccountId))
      // A direct chat has a customer identity; a group chat has a group.
      .leftJoin(schema.contactIdentity, eq(schema.contactIdentity.id, schema.conversation.contactIdentityId))
      .leftJoin(schema.channelGroup, eq(schema.channelGroup.id, schema.conversation.groupId))
      .where(eq(schema.message.id, job.data.messageId))
      .limit(1);
    if (!row) return;
    const { message, account, conversation, identity, group } = row;
    if (message.status !== "queued" && message.status !== "sending") return; // Already sent or given up.
    // "sending" on arrival means an earlier attempt reached the send call and did not finish
    // (a crash, or a failure after Meta accepted it). It may have been sent: never send twice.
    if (message.status === "sending") {
      await fail(message.id, {
        reason: "unknown",
        message: "An earlier attempt may already have sent this message, so it was not sent again.",
      });
      throw new UnrecoverableError("previous attempt may have sent it");
    }

    if (account.status !== "active") {
      await fail(message.id, { reason: "channel_unavailable", message: `The channel is ${account.status}` });
      throw new UnrecoverableError("channel not active");
    }
    if (!conversation.windowExpiresAt || conversation.windowExpiresAt <= new Date()) {
      await fail(message.id, {
        reason: "window_closed",
        message: "The reply window closed before the message was sent",
      });
      throw new UnrecoverableError("window closed");
    }
    const adapter = channels().get(account.type);
    if (!adapter) {
      await fail(message.id, {
        reason: "unsupported_channel",
        message: `Sending on ${account.type} is not built yet`,
      });
      throw new UnrecoverableError("unsupported channel");
    }
    let to: Recipient;
    if (conversation.kind === "group") {
      if (!group?.externalId || group.status !== "active") {
        await fail(message.id, {
          reason: "group_unavailable",
          message: `The group is ${group?.status ?? "missing"}`,
        });
        throw new UnrecoverableError("group not active");
      }
      const allowed = adapter.capabilities.groups?.outboundTypes ?? [];
      if (!allowed.includes((message.content as { type: OutboundMessage["type"] }).type)) {
        await fail(message.id, {
          reason: "unsupported_in_group",
          message: `This channel cannot send ${message.type} messages to groups`,
        });
        throw new UnrecoverableError("type not allowed in group");
      }
      to = { kind: "group", groupExternalId: group.externalId };
    } else {
      if (!identity) throw new UnrecoverableError("direct conversation without identity");
      to = {
        kind: "direct",
        phone: identity.phone,
        userId: identity.externalId.includes(".") ? identity.externalId : null,
      };
    }

    // Files are handed to the channel first; that step is safe to retry, the send itself is not.
    const media = mediaTypes.has(message.type)
      ? await providerMediaFor(message.id, adapter, account).catch(async (err) => {
          if (err instanceof GraphError && err.kind !== "retryable" && err.kind !== "rateLimited") {
            await fail(message.id, { reason: err.kind, code: err.code ?? null, message: err.message });
            throw new UnrecoverableError(err.message);
          }
          if (err instanceof UnrecoverableError)
            await fail(message.id, { reason: "error", message: err.message });
          throw err;
        })
      : null;

    await throttle(job, account.id, token);
    await db.update(schema.message).set({ status: "sending" }).where(eq(schema.message.id, message.id));

    const content = message.content as { type: string; text?: string; caption?: string | null };
    let replyToExternalId: string | undefined;
    if (message.replyToMessageId) {
      const [target] = await db
        .select({ externalId: schema.message.externalId })
        .from(schema.message)
        .where(eq(schema.message.id, message.replyToMessageId))
        .limit(1);
      replyToExternalId = target?.externalId ?? undefined;
    }
    const outbound: OutboundMessage = media
      ? {
          type: message.type as "image" | "video" | "audio" | "document" | "sticker",
          providerMediaId: media.id,
          caption: content.caption ?? undefined,
          fileName: media.file.fileName ?? undefined,
          replyToExternalId,
        }
      : { type: "text", text: content.text ?? "", replyToExternalId };

    try {
      const { externalId } = await adapter.send(accountRef(account), to, outbound, message.id);
      await recordAccepted(message.id, externalId);
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
  }
}
