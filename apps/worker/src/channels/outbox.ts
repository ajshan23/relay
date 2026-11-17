import {
  type ChannelAdapter,
  GraphError,
  GraphUncertainError,
  type OutboundMessage,
  type Recipient,
} from "@relay/channels";
import { fileStorage, publishInboxEvent } from "@relay/core";
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
  const storage = fileStorage();

  /**
   * Hands a stored file to a channel number once and reuses the channel's media id for later sends
   * from that number (WhatsApp keeps media 30 days; reused for 25). A broadcast uploads its file once
   * per number, not once per recipient. Files from before stored_file upload as before.
   */
  async function uploadOnce(
    file: typeof schema.attachment.$inferSelect & { storageKey: string },
    adapter: ChannelAdapter,
    account: typeof schema.channelAccount.$inferSelect,
  ) {
    const pm = schema.providerMedia;
    if (file.fileId) {
      const [hit] = await db
        .select({ id: pm.providerMediaId })
        .from(pm)
        .where(
          and(
            eq(pm.fileId, file.fileId),
            eq(pm.channelAccountId, account.id),
            sql`${pm.uploadedAt} > (now() at time zone 'utc') - interval '25 days'`,
          ),
        )
        .limit(1);
      if (hit) return hit.id;
    }
    const { providerMediaId } = await adapter.uploadMedia(accountRef(account), {
      bytes: await storage.get(file.storageKey),
      mimeType: file.mimeType ?? "application/octet-stream",
      fileName: file.fileName ?? file.id,
    });
    if (file.fileId)
      await db
        .insert(pm)
        .values({ fileId: file.fileId, channelAccountId: account.id, providerMediaId })
        .onConflictDoUpdate({
          target: [pm.fileId, pm.channelAccountId],
          set: { providerMediaId, uploadedAt: new Date() },
        });
    return providerMediaId;
  }

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
      const providerMediaId = await uploadOnce({ ...file, storageKey: file.storageKey }, adapter, account);
      await db.update(schema.attachment).set({ providerMediaId }).where(eq(schema.attachment.id, file.id));
      return { id: providerMediaId, file };
    } catch (err) {
      // An upload never reaches the customer, so an unanswered one is safe to retry.
      if (err instanceof GraphUncertainError) throw new Error(err.message);
      throw err;
    }
  }

  async function fail(messageId: string, error: Record<string, unknown>) {
    const [row] = await db
      .update(schema.message)
      .set({ status: "failed", failedAt: new Date(), error })
      .where(and(eq(schema.message.id, messageId), inArray(schema.message.status, ["queued", "sending"])))
      .returning({
        broadcastId: schema.message.broadcastId,
        channelAccountId: schema.message.channelAccountId,
      });
    if (row?.broadcastId) await haltBroadcast(row.broadcastId, row.channelAccountId, error);
  }

  /**
   * A broadcast message failed in a way that means the rest would fail too (a bad template) or that
   * sending more is unsafe (spam limit, billing): pause or stop the broadcast now, not on the engine's
   * next tick, so the messages already queued behind it are held back by the check before sending.
   */
  async function haltBroadcast(
    broadcastId: string,
    channelAccountId: string,
    error: Record<string, unknown>,
  ) {
    const [account] = await db
      .select({ type: schema.channelAccount.type })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, channelAccountId))
      .limit(1);
    const action = account
      ? channels()
          .get(account.type)
          ?.broadcastError?.(error.code as number | undefined, String(error.message ?? ""))
      : undefined;
    if (action?.action !== "stop" && action?.action !== "pause") return;
    await db
      .update(schema.broadcast)
      .set({
        status: action.action === "stop" ? "stopped" : "paused",
        pauseReason: action.pauseReason,
        pauseDetail: action.reason,
        updatedAt: new Date(),
        ...(action.action === "stop" ? { completedAt: new Date() } : {}),
      })
      .where(and(eq(schema.broadcast.id, broadcastId), eq(schema.broadcast.status, "sending")));
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
        broadcastId: schema.message.broadcastId,
      })
      .from(schema.message)
      .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
      .where(eq(schema.message.id, messageId))
      .limit(1);
    // Broadcast messages land quietly: no live event for each of thousands of sends.
    if (row && !row.broadcastId)
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

    // A broadcast paused or stopped since this was queued: don't send it.
    if (message.broadcastId) {
      const [bc] = await db
        .select({ status: schema.broadcast.status })
        .from(schema.broadcast)
        .where(eq(schema.broadcast.id, message.broadcastId))
        .limit(1);
      if (bc?.status !== "sending") {
        const r = schema.broadcastRecipient;
        await db.transaction(async (tx) => {
          await tx
            .update(r)
            .set(
              bc?.status === "paused"
                ? { status: "pending", messageId: null, updatedAt: new Date() }
                : { status: "skipped", skipReason: "stopped", messageId: null, updatedAt: new Date() },
            )
            .where(eq(r.messageId, message.id));
          await tx.delete(schema.message).where(eq(schema.message.id, message.id));
        });
        return;
      }
    }

    if (account.status !== "active") {
      await fail(message.id, { reason: "channel_unavailable", message: `The channel is ${account.status}` });
      throw new UnrecoverableError("channel not active");
    }
    // Templates are what channels allow outside the window; everything else needs it open.
    const isTemplate = message.type === "template";
    if (!isTemplate && (!conversation.windowExpiresAt || conversation.windowExpiresAt <= new Date())) {
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
      const allowed: string[] = adapter.capabilities.groups?.outboundTypes ?? [];
      if (!allowed.includes(message.type)) {
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

    // A template with a picture, video or file header hands that file to the channel first.
    let headerMedia: Extract<OutboundMessage, { type: "template" }>["headerMedia"];
    const header = (message.content as { header?: { kind: string; attachmentId?: string | null } | null })
      .header;
    // So does a link button with a picture, video or file on top.
    // …and a catalogue card: reply buttons with the item's main photo on top.
    const interactiveKind =
      message.type === "interactive" ? (message.content as { kind?: string }).kind : null;
    const isLinkButton = interactiveKind === "cta_url" || interactiveKind === "buttons";
    if ((isTemplate || isLinkButton) && header && header.kind !== "text" && header.attachmentId) {
      const [file] = await db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.id, header.attachmentId))
        .limit(1);
      if (!file?.storageKey) {
        await fail(message.id, { reason: "error", message: "The file on top of this message is missing." });
        throw new UnrecoverableError("header file missing");
      }
      const providerMediaId = await uploadOnce(
        { ...file, storageKey: file.storageKey },
        adapter,
        account,
      ).catch(async (err) => {
        // Nothing was sent yet, so temporary failures retry; a refusal fails the message.
        const temporary =
          err instanceof GraphUncertainError ||
          (err instanceof GraphError && (err.kind === "retryable" || err.kind === "rateLimited"));
        const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (temporary && !lastAttempt)
          throw err instanceof GraphUncertainError ? new Error(err.message) : err;
        await fail(message.id, {
          reason: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        throw new UnrecoverableError("template header upload failed");
      });
      headerMedia = {
        kind: header.kind as "image" | "video" | "document",
        providerMediaId,
        fileName: file.fileName ?? undefined,
      };
    }

    // Carousel cards carry their pictures as links WhatsApp fetches: signed for a week.
    let carouselLinks: Map<string, string> | undefined;
    if (interactiveKind === "carousel") {
      const cards = ((message.content as { cards?: { fileId?: string }[] }).cards ?? []).map(
        (c) => c.fileId ?? "",
      );
      const files = cards.length
        ? await db
            .select({
              id: schema.storedFile.id,
              storageKey: schema.storedFile.storageKey,
              mimeType: schema.storedFile.mimeType,
            })
            .from(schema.storedFile)
            .where(
              and(
                inArray(schema.storedFile.id, cards),
                eq(schema.storedFile.organizationId, message.organizationId),
              ),
            )
        : [];
      carouselLinks = new Map();
      for (const f of files) {
        const link = await storage.signedUrl(f.storageKey, {
          expiresIn: 7 * 24 * 3600,
          contentType: f.mimeType,
          inline: true,
        });
        if (link) carouselLinks.set(f.id, link);
      }
      if (cards.length < 2 || cards.some((id) => !carouselLinks?.has(id))) {
        await fail(message.id, {
          reason: "error",
          message:
            "The pictures for these cards couldn't be prepared (they need file storage that gives links).",
        });
        throw new UnrecoverableError("carousel media missing");
      }
    }

    await throttle(job, account.id, token);
    await db.update(schema.message).set({ status: "sending" }).where(eq(schema.message.id, message.id));

    const content = message.content as {
      type: string;
      text?: string;
      caption?: string | null;
      name?: string;
      language?: string;
      values?: Record<string, string>;
      auth?: boolean;
      header?: { kind: string; attachmentId?: string | null } | null;
    };
    let replyToExternalId: string | undefined;
    if (message.replyToMessageId) {
      const [target] = await db
        .select({ externalId: schema.message.externalId })
        .from(schema.message)
        .where(eq(schema.message.id, message.replyToMessageId))
        .limit(1);
      replyToExternalId = target?.externalId ?? undefined;
    }
    // A reaction points at a message by its provider id, known once that message was accepted.
    let reactionTarget: string | null = null;
    if (message.type === "reaction") {
      const r = message.content as { targetMessageId?: string; targetExternalId?: string };
      if (r.targetExternalId) reactionTarget = r.targetExternalId;
      else if (r.targetMessageId) {
        const [target] = await db
          .select({ externalId: schema.message.externalId })
          .from(schema.message)
          .where(eq(schema.message.id, r.targetMessageId))
          .limit(1);
        reactionTarget = target?.externalId ?? null;
      }
      if (!reactionTarget) {
        await fail(message.id, {
          reason: "error",
          message: "That message hasn't reached WhatsApp, so it can't get a reaction.",
        });
        throw new UnrecoverableError("reaction target has no provider id");
      }
    }
    const outbound: OutboundMessage = reactionTarget
      ? {
          type: "reaction",
          targetExternalId: reactionTarget,
          emoji: (message.content as { emoji?: string }).emoji ?? "",
        }
      : message.type === "interactive"
        ? interactiveOutbound(message.content, replyToExternalId, headerMedia, carouselLinks)
        : message.type === "location"
          ? locationOutbound(message.content, replyToExternalId)
          : isTemplate
            ? {
                type: "template",
                name: content.name ?? "",
                language: content.language ?? "en",
                values: content.values ?? {},
                auth: !!content.auth,
                headerMedia,
                quickReplyPayloads: (
                  message.content as { quickReplyPayloads?: { index: number; payload: string }[] }
                ).quickReplyPayloads,
                replyToExternalId,
              }
            : media
              ? {
                  type: message.type as "image" | "video" | "audio" | "document" | "sticker",
                  providerMediaId: media.id,
                  caption: content.caption ?? undefined,
                  fileName: media.file.fileName ?? undefined,
                  voice: message.type === "audio" && (message.content as { voice?: boolean }).voice === true,
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
          // 131062: login-code templates need a phone number, and this person shares only a WhatsApp username.
          message:
            err.code === 131062
              ? "This person uses a WhatsApp username and hasn't shared their phone number, so a login-code template can't be sent to them."
              : err.message,
          details: err.details ?? null,
        };
        if (err.kind === "authFailed") {
          await db
            .update(schema.channelAccount)
            .set({
              status: "error",
              statusReason: `Meta stopped accepting Relay's access to this number (${err.message}). Reconnect it in Settings → Channels.`,
              updatedAt: new Date(),
            })
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

/**
 * A stored interactive message (see packages/channels OutboundMessage "interactive"): a question with
 * choices, a link button, or a location request.
 */
function interactiveOutbound(
  content: Record<string, unknown>,
  replyToExternalId?: string,
  headerMedia?: { kind: "image" | "video" | "document"; providerMediaId: string; fileName?: string },
  carouselLinks?: Map<string, string>,
): OutboundMessage {
  const c = content as {
    kind?: string;
    body?: string;
    buttonText?: string;
    footer?: string | null;
    options?: { id: string; title: string; description?: string }[];
    button?: { text: string; url: string };
  };
  if (c.kind === "location_request")
    return { type: "interactive", kind: "location_request", body: c.body ?? "", replyToExternalId };
  if (c.kind === "carousel") {
    const cards = (content.cards ?? []) as {
      fileId: string;
      mediaKind: "image" | "video";
      body?: string;
      buttons: { id: string; title: string }[];
    }[];
    return {
      type: "interactive",
      kind: "carousel",
      body: c.body ?? "",
      cards: cards.map((card) => ({
        media: { kind: card.mediaKind, link: carouselLinks?.get(card.fileId) ?? "" },
        body: card.body,
        buttons: card.buttons,
      })),
      replyToExternalId,
    };
  }
  if (c.kind === "cta_url")
    return {
      type: "interactive",
      kind: "cta_url",
      body: c.body ?? "",
      button: c.button ?? { text: "Open", url: "" },
      headerMedia,
      footer: c.footer ?? undefined,
      replyToExternalId,
    };
  return {
    type: "interactive",
    kind: c.kind === "list" ? "list" : "buttons",
    body: c.body ?? "",
    options: c.options ?? [],
    buttonText: c.buttonText,
    footer: c.footer ?? undefined,
    ...(c.kind !== "list" && headerMedia ? { headerMedia } : {}),
    replyToExternalId,
  };
}

/** A stored map pin. */
function locationOutbound(content: Record<string, unknown>, replyToExternalId?: string): OutboundMessage {
  const c = content as {
    latitude?: number;
    longitude?: number;
    name?: string | null;
    address?: string | null;
  };
  return {
    type: "location",
    latitude: Number(c.latitude),
    longitude: Number(c.longitude),
    name: c.name ?? undefined,
    address: c.address ?? undefined,
    replyToExternalId,
  };
}
