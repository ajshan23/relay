import {
  type ChannelIdentity,
  type ChannelRegistry,
  type ContactChangedEvent,
  type GroupEvent,
  type MessageReceived,
  type MessageStatusEvent,
  type NormalizedEvent,
  type ReactionEvent,
  type StoredStatus,
  shouldApplyStatus,
  toStoredStatus,
  windowExpiresAt,
} from "@relay/channels";
import { type InboxEvent, messagePreview, newId } from "@relay/core";
import { type AnyColumn, and, type createDb, eq, inArray, or, schema, sql } from "@relay/db";

/*
 * Turns stored webhook events into contacts, conversations, groups and messages, for any channel.
 * Safe to run twice on the same event: messages are unique per channel and provider id, statuses and
 * receipts only move forward, and group changes are idempotent.
 */

type Db = ReturnType<typeof createDb>["db"];
type Account = typeof schema.channelAccount.$inferSelect;
type Group = typeof schema.channelGroup.$inferSelect;
type Identity = typeof schema.contactIdentity.$inferSelect;

/**
 * The later of a timestamp column and a time. Timestamps are stored as UTC without a zone, the way
 * Drizzle writes them, so the time is passed as a UTC string and cast.
 */
function latest(column: AnyColumn, at: Date) {
  return sql`greatest(${column}, ${at.toISOString()}::timestamptz at time zone 'UTC')`;
}

export type IngestResult = {
  events: number;
  unrouted: number;
  media: string[];
  /** What changed, for live updates in open inboxes. */
  changed: { organizationId: string; event: InboxEvent }[];
};

export function createIngest(db: Db, registry: ChannelRegistry) {
  /** Changes made while ingesting the current webhook; reset per ingest() call. */
  let changed: IngestResult["changed"] = [];
  const touched = (c: { id: string; organizationId: string; branchId: string | null }, messageId?: string) =>
    changed.push({
      organizationId: c.organizationId,
      event: messageId
        ? { type: "message.updated", conversationId: c.id, branchId: c.branchId, messageId }
        : { type: "conversation.updated", conversationId: c.id, branchId: c.branchId },
    });

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
  async function upsertIdentity(account: Account, from: ChannelIdentity): Promise<Identity> {
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

  async function upsertDirectConversation(account: Account, identity: { id: string; contactId: string }) {
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

  /** The group a message or event belongs to. Created as a placeholder if the channel told us about it first. */
  async function findOrCreateGroup(account: Account, groupExternalId: string): Promise<Group> {
    const where = and(
      eq(schema.channelGroup.channelAccountId, account.id),
      eq(schema.channelGroup.externalId, groupExternalId),
    );
    const [found] = await db.select().from(schema.channelGroup).where(where).limit(1);
    if (found) return found;
    await db
      .insert(schema.channelGroup)
      .values({
        id: newId("group"),
        organizationId: account.organizationId,
        channelAccountId: account.id,
        branchId: account.defaultBranchId,
        externalId: groupExternalId,
        status: "active",
      })
      .onConflictDoNothing();
    const [row] = await db.select().from(schema.channelGroup).where(where).limit(1);
    if (!row) throw new Error("group vanished");
    return row;
  }

  async function upsertGroupConversation(account: Account, group: Group) {
    await db
      .insert(schema.conversation)
      .values({
        id: newId("conversation"),
        organizationId: account.organizationId,
        branchId: group.branchId ?? account.defaultBranchId,
        channelAccountId: account.id,
        kind: "group",
        groupId: group.id,
      })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.channelAccountId, account.id),
          eq(schema.conversation.kind, "group"),
          eq(schema.conversation.groupId, group.id),
        ),
      )
      .limit(1);
    if (!row) throw new Error("group conversation vanished");
    return row;
  }

  /** Marks people as in (or out of) a group and keeps the group's head count right. */
  async function setParticipants(
    group: Group,
    identities: Identity[],
    status: "active" | "left" | "removed",
    at: Date,
  ) {
    for (const identity of identities) {
      await db
        .insert(schema.groupParticipant)
        .values({
          id: newId("groupParticipant"),
          organizationId: group.organizationId,
          groupId: group.id,
          contactIdentityId: identity.id,
          status,
          joinedAt: at,
          leftAt: status === "active" ? null : at,
        })
        .onConflictDoUpdate({
          target: [schema.groupParticipant.groupId, schema.groupParticipant.contactIdentityId],
          set: status === "active" ? { status, leftAt: null } : { status, leftAt: at },
        });
    }
    await db
      .update(schema.channelGroup)
      .set({
        participantCount: sql`(select count(*) from ${schema.groupParticipant} where ${schema.groupParticipant.groupId} = ${group.id} and ${schema.groupParticipant.status} = 'active')`,
        updatedAt: new Date(),
      })
      .where(eq(schema.channelGroup.id, group.id));
  }

  /** Reply window length for a conversation on this channel (groups can differ from direct chats). */
  function windowHours(account: Account, kind: "direct" | "group") {
    const caps = registry.get(account.type)?.capabilities;
    return kind === "group" ? (caps?.groups?.replyWindowHours ?? null) : (caps?.replyWindowHours ?? null);
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
    const sentAt = event.kind === "reaction" ? event.at : event.sentAt;
    let conversation: typeof schema.conversation.$inferSelect;
    if (event.conversation.kind === "group") {
      const group = await findOrCreateGroup(account, event.conversation.groupExternalId);
      conversation = await upsertGroupConversation(account, group);
      // Anyone writing in the group is a participant, even if the join webhook has not arrived yet.
      await setParticipants(group, [identity], "active", sentAt);
    } else {
      conversation = await upsertDirectConversation(account, identity);
    }

    const isReaction = event.kind === "reaction";
    const content = isReaction
      ? {
          type: "reaction",
          emoji: event.emoji,
          targetExternalId: event.targetExternalId,
          targetMessageId: await messageIdByExternal(account.id, event.targetExternalId),
        }
      : { ...event.content, context: event.context, errors: event.errors };

    const replyToMessageId = isReaction
      ? null
      : await messageIdByExternal(account.id, event.context.replyToExternalId);
    const media =
      !isReaction && "media" in event.content && event.content.media.providerMediaId ? event.content : null;
    const hours = windowHours(account, event.conversation.kind);
    const window = hours === null ? null : windowExpiresAt(sentAt, hours);

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
      touched(conversation);

      await tx
        .update(schema.conversation)
        .set({
          status: "open",
          lastMessageAt: latest(schema.conversation.lastMessageAt, sentAt),
          lastInboundAt: latest(schema.conversation.lastInboundAt, sentAt),
          ...(window ? { windowExpiresAt: latest(schema.conversation.windowExpiresAt, window) } : {}),
          lastMessagePreview: messagePreview(
            isReaction ? "reaction" : event.content.type,
            content as Record<string, unknown>,
            "inbound",
            event.conversation.kind === "group" ? (identity.profileName ?? identity.phone) : null,
          ),
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
    // Group messages: track each participant's delivery and read on its own.
    if (event.recipient.kind === "group" && event.recipient.participant) {
      const who = await upsertIdentity(account, event.recipient.participant);
      const [receipt] = await db
        .select()
        .from(schema.messageReceipt)
        .where(
          and(
            eq(schema.messageReceipt.messageId, row.id),
            eq(schema.messageReceipt.contactIdentityId, who.id),
          ),
        )
        .limit(1);
      if (!receipt || shouldApplyStatus(receipt.status as StoredStatus, next)) {
        const times = {
          ...(next === "delivered" || next === "read"
            ? { deliveredAt: receipt?.deliveredAt ?? event.at }
            : {}),
          ...(next === "read" ? { readAt: event.at } : {}),
          ...(next === "failed" ? { failedAt: event.at, error: { errors: event.errors } } : {}),
        };
        await db
          .insert(schema.messageReceipt)
          .values({
            id: newId("receipt"),
            organizationId: row.organizationId,
            messageId: row.id,
            contactIdentityId: who.id,
            status: next,
            ...times,
          })
          .onConflictDoUpdate({
            target: [schema.messageReceipt.messageId, schema.messageReceipt.contactIdentityId],
            set: { status: next, ...times, updatedAt: new Date() },
          });
      }
    }
    if (!shouldApplyStatus(row.status as StoredStatus, next)) {
      if (event.recipient.kind === "group") await messageChanged(row); // a receipt may have changed
      return;
    }
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
    await messageChanged(row);
  }

  async function messageChanged(row: { id: string; conversationId: string }) {
    const [c] = await db
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.id, row.conversationId))
      .limit(1);
    if (c) touched(c, row.id);
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

  /** A group we asked the channel to create, matched by our request id, or one we know by its id. */
  async function groupFor(account: Account, event: GroupEvent): Promise<Group | null> {
    const conditions = [
      event.requestId ? eq(schema.channelGroup.requestId, event.requestId) : undefined,
      event.groupExternalId ? eq(schema.channelGroup.externalId, event.groupExternalId) : undefined,
    ].filter(Boolean);
    if (!conditions.length) return null;
    const rows = await db
      .select()
      .from(schema.channelGroup)
      .where(and(eq(schema.channelGroup.channelAccountId, account.id), or(...conditions)));
    // Our own request wins over a placeholder made from an early message.
    const row = rows.find((r) => event.requestId && r.requestId === event.requestId) ?? rows[0];
    if (row) return row;
    // A group created outside Relay (for example in WhatsApp Manager) still gets a record.
    return event.groupExternalId ? findOrCreateGroup(account, event.groupExternalId) : null;
  }

  async function updateGroup(group: Group, set: Partial<typeof schema.channelGroup.$inferInsert>) {
    await db
      .update(schema.channelGroup)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(schema.channelGroup.id, group.id));
  }

  /** Applies a channel-agnostic group event. */
  async function groupEvent(account: Account, event: GroupEvent) {
    const group = await groupFor(account, event);
    if (!group) return;
    await applyGroupEvent(account, event, group);
    const [c] = await db
      .select()
      .from(schema.conversation)
      .where(and(eq(schema.conversation.kind, "group"), eq(schema.conversation.groupId, group.id)))
      .limit(1);
    if (c) touched(c);
  }

  async function applyGroupEvent(account: Account, event: GroupEvent, group: Group) {
    switch (event.kind) {
      case "group.created": {
        const externalId = event.groupExternalId ?? group.externalId;
        await db.transaction(async (tx) => {
          // A member's message can arrive before this confirmation and create a placeholder record
          // for the same group. Fold the placeholder into the group we asked for, then confirm it.
          if (externalId && group.externalId !== externalId) {
            const [placeholder] = await tx
              .select({ id: schema.channelGroup.id })
              .from(schema.channelGroup)
              .where(
                and(
                  eq(schema.channelGroup.channelAccountId, account.id),
                  eq(schema.channelGroup.externalId, externalId),
                ),
              )
              .limit(1);
            if (placeholder && placeholder.id !== group.id) {
              await tx
                .update(schema.conversation)
                .set({ groupId: group.id })
                .where(eq(schema.conversation.groupId, placeholder.id));
              await tx
                .update(schema.groupParticipant)
                .set({ groupId: group.id })
                .where(eq(schema.groupParticipant.groupId, placeholder.id));
              await tx
                .update(schema.groupJoinRequest)
                .set({ groupId: group.id })
                .where(eq(schema.groupJoinRequest.groupId, placeholder.id));
              await tx.delete(schema.channelGroup).where(eq(schema.channelGroup.id, placeholder.id));
            }
          }
          await tx
            .update(schema.channelGroup)
            .set({
              externalId,
              status: "active",
              statusReason: null,
              subject: event.subject ?? group.subject,
              description: event.description ?? group.description,
              inviteLink: event.inviteLink ?? group.inviteLink,
              joinApprovalMode: event.joinApprovalMode ?? group.joinApprovalMode,
              participantCount: sql`(select count(*) from ${schema.groupParticipant} where ${schema.groupParticipant.groupId} = ${group.id} and ${schema.groupParticipant.status} = 'active')`,
              updatedAt: new Date(),
            })
            .where(eq(schema.channelGroup.id, group.id));
        });
        await upsertGroupConversation(account, { ...group, externalId });
        return;
      }
      case "group.failed": {
        const reason =
          event.errors.map((e) => e.message ?? e.title ?? String(e.code)).join("; ") ||
          "The channel refused the request";
        await updateGroup(
          group,
          event.operation === "create"
            ? { status: "failed", statusReason: reason }
            : { statusReason: reason },
        );
        return;
      }
      case "group.deleted": {
        await updateGroup(group, { status: "deleted", deletedAt: event.at, inviteLink: null });
        await db
          .update(schema.conversation)
          .set({ status: "closed", windowExpiresAt: null, updatedAt: new Date() })
          .where(eq(schema.conversation.groupId, group.id));
        await db
          .update(schema.groupParticipant)
          .set({ status: "removed", leftAt: event.at })
          .where(
            and(eq(schema.groupParticipant.groupId, group.id), eq(schema.groupParticipant.status, "active")),
          );
        await updateGroup(group, { participantCount: 0 });
        return;
      }
      case "group.updated":
        await updateGroup(group, {
          ...(event.subject !== undefined ? { subject: event.subject } : {}),
          ...(event.description !== undefined ? { description: event.description } : {}),
          statusReason: event.errors.length
            ? event.errors.map((e) => e.message ?? e.title).join("; ")
            : group.statusReason,
        });
        return;
      case "group.suspended":
        await updateGroup(group, { status: "suspended" });
        return;
      case "group.restored":
        await updateGroup(group, { status: "active" });
        return;
      case "group.participants_added": {
        const identities = [];
        for (const p of event.participants) identities.push(await upsertIdentity(account, p));
        await setParticipants(group, identities, "active", event.at);
        // Anyone who joined had any pending request approved.
        if (identities.length) {
          await db
            .update(schema.groupJoinRequest)
            .set({ status: "approved", decidedAt: event.at })
            .where(
              and(
                eq(schema.groupJoinRequest.groupId, group.id),
                eq(schema.groupJoinRequest.status, "pending"),
                inArray(
                  schema.groupJoinRequest.contactIdentityId,
                  identities.map((i) => i.id),
                ),
              ),
            );
        }
        return;
      }
      case "group.participants_removed": {
        const identities = [];
        for (const p of event.participants) identities.push(await upsertIdentity(account, p));
        await setParticipants(
          group,
          identities,
          event.initiatedBy === "participant" ? "left" : "removed",
          event.at,
        );
        return;
      }
      case "group.join_requested": {
        const who = await upsertIdentity(account, event.participant);
        await db
          .insert(schema.groupJoinRequest)
          .values({
            id: newId("groupJoinRequest"),
            organizationId: group.organizationId,
            groupId: group.id,
            externalId: event.requestExternalId,
            contactIdentityId: who.id,
            createdAt: event.at,
          })
          .onConflictDoNothing();
        return;
      }
      case "group.join_request_withdrawn":
        await db
          .update(schema.groupJoinRequest)
          .set({ status: "withdrawn", decidedAt: event.at })
          .where(
            and(
              eq(schema.groupJoinRequest.groupId, group.id),
              eq(schema.groupJoinRequest.externalId, event.requestExternalId),
              eq(schema.groupJoinRequest.status, "pending"),
            ),
          );
        return;
    }
  }

  /** Applies every event in one stored webhook. */
  async function ingest(events: NormalizedEvent[]): Promise<IngestResult> {
    changed = [];
    const result: IngestResult = { events: events.length, unrouted: 0, media: [], changed };
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
      else if (event.kind.startsWith("group.")) await groupEvent(account, event as GroupEvent);
      // account.update: kept in webhook_event only, for now.
    }
    return result;
  }

  return { ingest };
}
