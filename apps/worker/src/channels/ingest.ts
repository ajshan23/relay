import {
  type ContactChangedEvent,
  type MessageReceived,
  type MessageStatusEvent,
  type NormalizedEvent,
  parseWhatsAppWebhook,
  type ReactionEvent,
  type StoredStatus,
  shouldApplyStatus,
  toStoredStatus,
  whatsappCapabilities,
  windowExpiresAt,
} from "@relay/channels";
import { newId } from "@relay/core";
import { type AnyColumn, and, type createDb, eq, schema, sql } from "@relay/db";

/*
 * Turns stored webhook events into contacts, conversations and messages. Safe to run twice on the
 * same event: messages are unique per channel and provider id, and statuses only move forward.
 */

type Db = ReturnType<typeof createDb>["db"];
type Account = typeof schema.channelAccount.$inferSelect;

/**
 * The later of a timestamp column and a time. Timestamps are stored as UTC without a zone, the way
 * Drizzle writes them, so the time is passed as a UTC string and cast.
 */
function latest(column: AnyColumn, at: Date) {
  return sql`greatest(${column}, ${at.toISOString()}::timestamptz at time zone 'UTC')`;
}

export type IngestResult = { events: number; unrouted: number; media: string[] };

/** Parses a stored webhook payload with the right adapter. */
export function parseStoredEvent(provider: string, payload: unknown): NormalizedEvent[] {
  if (provider !== "meta") return [];
  const object = (payload as { object?: string } | null)?.object;
  if (object === "whatsapp_business_account") return parseWhatsAppWebhook(payload);
  // Instagram ("instagram") and Messenger ("page") adapters come later; their events stay stored for replay.
  return [];
}

export function createIngest(db: Db) {
  // Found channels are remembered briefly (a number can be disconnected); misses are never
  // remembered, so a number connected a moment ago is picked up straight away.
  const accounts = new Map<string, { account: Account; until: number }>();
  const ACCOUNT_CACHE_MS = 30_000;

  async function findAccount(event: NormalizedEvent): Promise<Account | null> {
    const key = `${event.channel}:${event.accountExternalId}`;
    const cached = accounts.get(key);
    if (cached && cached.until > Date.now()) return cached.account;
    const [row] = await db
      .select()
      .from(schema.channelAccount)
      .where(
        and(
          eq(schema.channelAccount.type, event.channel),
          eq(schema.channelAccount.externalId, event.accountExternalId),
        ),
      )
      .limit(1);
    if (!row || row.status === "disconnected") {
      accounts.delete(key);
      return null;
    }
    accounts.set(key, { account: row, until: Date.now() + ACCOUNT_CACHE_MS });
    return row;
  }

  /** Finds or creates the contact identity, following a switch from phone-based id to BSUID. */
  async function upsertIdentity(account: Account, from: MessageReceived["from"]) {
    const where = (externalId: string) =>
      and(
        eq(schema.contactIdentity.organizationId, account.organizationId),
        eq(schema.contactIdentity.channelType, account.type),
        eq(schema.contactIdentity.scope, from.scope),
        eq(schema.contactIdentity.externalId, externalId),
      );

    let [identity] = await db.select().from(schema.contactIdentity).where(where(from.externalId)).limit(1);
    // Known before by phone only: the BSUID now takes over as the id.
    if (!identity && from.phone && from.phone !== from.externalId) {
      [identity] = await db.select().from(schema.contactIdentity).where(where(from.phone)).limit(1);
    }

    if (identity) {
      const changes = {
        externalId: from.externalId,
        phone: from.phone ?? identity.phone,
        username: from.username ?? identity.username,
        profileName: from.profileName ?? identity.profileName,
      };
      if (Object.entries(changes).some(([k, v]) => identity[k as keyof typeof identity] !== v)) {
        await db
          .update(schema.contactIdentity)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(schema.contactIdentity.id, identity.id));
      }
      return identity;
    }

    // New customer: the contact and its identity are created together. If another worker created the
    // same identity a moment earlier, this transaction is rolled back so no empty contact is left behind.
    const created = await db
      .transaction(async (tx) => {
        const contactId = newId("contact");
        await tx
          .insert(schema.contact)
          .values({ id: contactId, organizationId: account.organizationId, name: from.profileName });
        const [row] = await tx
          .insert(schema.contactIdentity)
          .values({
            id: newId("contactIdentity"),
            organizationId: account.organizationId,
            contactId,
            channelType: account.type,
            scope: from.scope,
            externalId: from.externalId,
            phone: from.phone,
            username: from.username,
            profileName: from.profileName,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) tx.rollback();
        return row;
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.toLowerCase().includes("rollback")) return undefined;
        throw err;
      });
    if (created) return created;
    const [existing] = await db.select().from(schema.contactIdentity).where(where(from.externalId)).limit(1);
    if (!existing) throw new Error("contact identity vanished");
    return existing;
  }

  async function upsertConversation(account: Account, identity: { id: string; contactId: string }) {
    await db
      .insert(schema.conversation)
      .values({
        id: newId("conversation"),
        organizationId: account.organizationId,
        branchId: account.defaultBranchId,
        channelAccountId: account.id,
        kind: "direct",
        contactId: identity.contactId,
        contactIdentityId: identity.id,
      })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.channelAccountId, account.id),
          eq(schema.conversation.kind, "direct"),
          eq(schema.conversation.contactIdentityId, identity.id),
        ),
      )
      .limit(1);
    if (!row) throw new Error("conversation vanished");
    return row;
  }

  async function messageIdByExternal(accountId: string, externalId: string | null) {
    if (!externalId) return null;
    const [row] = await db
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(and(eq(schema.message.channelAccountId, accountId), eq(schema.message.externalId, externalId)))
      .limit(1);
    return row?.id ?? null;
  }

  /** Stores an inbound message (or reaction). Returns attachment ids that need downloading. */
  async function received(account: Account, event: MessageReceived | ReactionEvent): Promise<string[]> {
    const identity = await upsertIdentity(account, event.from);
    const conversation = await upsertConversation(account, identity);
    const sentAt = event.kind === "reaction" ? event.at : event.sentAt;

    const isReaction = event.kind === "reaction";
    const content = isReaction
      ? {
          type: "reaction",
          emoji: event.emoji,
          targetExternalId: event.targetExternalId,
          targetMessageId: await messageIdByExternal(account.id, event.targetExternalId),
        }
      : { ...event.content, context: event.context, errors: event.errors, groupId: event.groupId };

    const replyToMessageId = isReaction
      ? null
      : await messageIdByExternal(account.id, event.context.replyToExternalId);
    const media =
      !isReaction && "media" in event.content && event.content.media.providerMediaId ? event.content : null;
    const window = windowExpiresAt(sentAt, whatsappCapabilities.replyWindowHours ?? 24);

    // The message, the conversation update and the attachment are saved together or not at all,
    // so a retry after a failure redoes everything instead of seeing a "duplicate" and stopping.
    return db.transaction(async (tx) => {
      const id = newId("message");
      const inserted = await tx
        .insert(schema.message)
        .values({
          id,
          organizationId: account.organizationId,
          conversationId: conversation.id,
          channelAccountId: account.id,
          direction: "inbound",
          senderType: "contact",
          senderIdentityId: identity.id,
          type: isReaction ? "reaction" : event.content.type,
          content: content as Record<string, unknown>,
          externalId: event.externalId,
          status: "received",
          replyToMessageId,
          sentAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.message.id });
      if (!inserted.length) return []; // Already stored: a repeated webhook.

      await tx
        .update(schema.conversation)
        .set({
          status: "open",
          lastMessageAt: latest(schema.conversation.lastMessageAt, sentAt),
          lastInboundAt: latest(schema.conversation.lastInboundAt, sentAt),
          windowExpiresAt: latest(schema.conversation.windowExpiresAt, window),
          updatedAt: new Date(),
        })
        .where(eq(schema.conversation.id, conversation.id));

      if (!media || !("media" in media)) return [];
      const attachmentId = newId("attachment");
      await tx.insert(schema.attachment).values({
        id: attachmentId,
        organizationId: account.organizationId,
        messageId: id,
        kind: media.type,
        mimeType: media.media.mimeType,
        fileName: media.media.fileName,
        sha256: media.media.sha256,
        providerMediaId: media.media.providerMediaId,
      });
      return [attachmentId];
    });
  }

  /** Moves an outbound message's status forward. Matched by provider id, or by our own id echoed back. */
  async function status(account: Account, event: MessageStatusEvent) {
    const byExternal = and(
      eq(schema.message.channelAccountId, account.id),
      eq(schema.message.externalId, event.externalId),
    );
    let [row] = await db.select().from(schema.message).where(byExternal).limit(1);
    if (!row && event.ourMessageId) {
      [row] = await db
        .select()
        .from(schema.message)
        .where(
          and(eq(schema.message.id, event.ourMessageId), eq(schema.message.channelAccountId, account.id)),
        )
        .limit(1);
    }
    if (!row) return; // Sent from outside Relay (for example WhatsApp Manager): nothing to update.

    const next: StoredStatus = toStoredStatus(event.status);
    if (!shouldApplyStatus(row.status as StoredStatus, next)) return;
    const stamp = {
      sent: {},
      delivered: { deliveredAt: event.at },
      read: { readAt: event.at, deliveredAt: row.deliveredAt ?? event.at },
      failed: { failedAt: event.at },
    }[next as "sent" | "delivered" | "read" | "failed"];
    await db
      .update(schema.message)
      .set({
        status: next,
        externalId: row.externalId ?? event.externalId,
        ...stamp,
        ...(event.errors.length ? { error: { errors: event.errors } } : {}),
      })
      .where(eq(schema.message.id, row.id));
  }

  /** The customer changed their number or WhatsApp id: their identity keeps its history. */
  async function contactChanged(account: Account, event: ContactChangedEvent) {
    if (!event.previousExternalId || !event.newExternalId) return;
    await db
      .update(schema.contactIdentity)
      .set({ externalId: event.newExternalId, phone: event.newPhone ?? undefined, updatedAt: new Date() })
      .where(
        and(
          eq(schema.contactIdentity.organizationId, account.organizationId),
          eq(schema.contactIdentity.channelType, account.type),
          eq(schema.contactIdentity.scope, event.scope),
          eq(schema.contactIdentity.externalId, event.previousExternalId),
        ),
      );
  }

  /** Applies every event in one stored webhook. */
  async function ingest(events: NormalizedEvent[]): Promise<IngestResult> {
    const result: IngestResult = { events: events.length, unrouted: 0, media: [] };
    for (const event of events) {
      const account = await findAccount(event);
      if (!account) {
        result.unrouted++;
        continue;
      }
      if (event.kind === "message.received" || event.kind === "reaction")
        result.media.push(...(await received(account, event)));
      else if (event.kind === "message.status") await status(account, event);
      else if (event.kind === "contact.changed") await contactChanged(account, event);
      // account.update: kept in webhook_event only, for now.
    }
    return result;
  }

  return { ingest };
}
