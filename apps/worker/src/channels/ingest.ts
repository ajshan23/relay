import {
  type AccountEvent,
  type AccountHealthEvent,
  type ChannelIdentity,
  type ChannelRegistry,
  type ContactChangedEvent,
  type ContactsSyncedEvent,
  type GroupEvent,
  type HistoryProgressEvent,
  identityScope,
  type MessageEditedEvent,
  type MessageReceived,
  type MessageRevokedEvent,
  type MessageStatusEvent,
  type NormalizedEvent,
  type PhoneAppMessageEvent,
  type ReactionEvent,
  type StoredStatus,
  shouldApplyStatus,
  type TemplateQualityEvent,
  type TemplateStatusEvent,
  toStoredStatus,
  windowExpiresAt,
} from "@relay/channels";
import { type InboxEvent, messagePreview, newId } from "@relay/core";
import type { InboundEventPayload } from "@relay/core/automations";
import { optOutReply } from "@relay/core/contacts";
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

/** Called inside the transaction that stores a new customer message in a one-to-one chat. */
export type InboundHook = (
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  event: InboundEventPayload,
) => Promise<void>;

export function createIngest(
  db: Db,
  registry: ChannelRegistry,
  hooks: {
    onInbound?: InboundHook;
    /** After the transaction that called onInbound committed (wakes the automation worker now). */
    afterInbound?: () => void;
  } = {},
) {
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

  async function findAccount(
    event: Exclude<NormalizedEvent, TemplateStatusEvent | TemplateQualityEvent | AccountHealthEvent>,
  ): Promise<Account | null> {
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

  // A channel without a branch counts as the business's first branch (oldest, not archived).
  const firstBranch = new Map<string, string>();
  async function branchFor(account: Account): Promise<string> {
    if (account.defaultBranchId) return account.defaultBranchId;
    const known = firstBranch.get(account.organizationId);
    if (known) return known;
    const [row] = await db
      .select({ id: schema.branch.id })
      .from(schema.branch)
      .where(eq(schema.branch.organizationId, account.organizationId))
      .orderBy(sql`${schema.branch.archivedAt} is not null`, schema.branch.createdAt)
      .limit(1);
    if (!row) throw new Error(`organization ${account.organizationId} has no branch`);
    firstBranch.set(account.organizationId, row.id);
    return row.id;
  }

  /**
   * Finds or creates the contact identity, following a switch from phone-based id to BSUID. Contacts
   * belong to a branch, so the same customer writing to two branches' numbers is two contacts.
   */
  async function upsertIdentity(account: Account, from: ChannelIdentity): Promise<Identity> {
    const branchId = await branchFor(account);
    // WhatsApp user ids are per business portfolio; identities made before we knew it used the account id.
    const scope = identityScope(account.providerMeta, from.scope);
    const scopes = scope === from.scope ? [scope] : [scope, from.scope];
    const where = (externalId: string) =>
      and(
        eq(schema.contactIdentity.organizationId, account.organizationId),
        eq(schema.contactIdentity.branchId, branchId),
        eq(schema.contactIdentity.channelType, account.type),
        inArray(schema.contactIdentity.scope, scopes),
        eq(schema.contactIdentity.externalId, externalId),
      );

    let [identity] = await db.select().from(schema.contactIdentity).where(where(from.externalId)).limit(1);
    // Known before by phone only: the BSUID now takes over as the id.
    if (!identity && from.phone && from.phone !== from.externalId) {
      [identity] = await db.select().from(schema.contactIdentity).where(where(from.phone)).limit(1);
    }

    if (identity) {
      const changes = {
        scope,
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
    // Someone added by hand or imported with this number joins that contact instead of becoming a new one.
    const [known] = from.phone
      ? await db
          .select({ id: schema.contact.id })
          .from(schema.contact)
          .where(
            and(
              eq(schema.contact.organizationId, account.organizationId),
              eq(schema.contact.branchId, branchId),
              eq(schema.contact.phone, from.phone),
            ),
          )
          .limit(1)
      : [];
    const created = await db
      .transaction(async (tx) => {
        const contactId = known?.id ?? newId("contact");
        if (!known)
          await tx.insert(schema.contact).values({
            id: contactId,
            organizationId: account.organizationId,
            name: from.profileName,
            phone: from.phone,
            branchId,
          });
        const [row] = await tx
          .insert(schema.contactIdentity)
          .values({
            id: newId("contactIdentity"),
            organizationId: account.organizationId,
            contactId,
            branchId,
            channelType: account.type,
            scope,
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

  async function upsertDirectConversation(
    account: Account,
    identity: { id: string; contactId: string },
    /** A conversation made by importing old phone-app chats starts closed, so the inbox isn't flooded. */
    opts: { closed?: boolean } = {},
  ) {
    await db
      .insert(schema.conversation)
      .values({
        id: newId("conversation"),
        organizationId: account.organizationId,
        branchId: await branchFor(account),
        channelAccountId: account.id,
        kind: "direct",
        contactId: identity.contactId,
        contactIdentityId: identity.id,
        ...(opts.closed ? { status: "closed" as const } : {}),
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
        branchId: group.branchId ?? (await branchFor(account)),
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
    let heard = false;
    const saved = await db.transaction(async (tx) => {
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
        .update(schema.contact)
        .set({ lastMessageAt: latest(schema.contact.lastMessageAt, sentAt) })
        .where(eq(schema.contact.id, identity.contactId));

      // "STOP" in a one-to-one chat opts them out of marketing on this channel; "START" undoes it.
      if (!isReaction && event.conversation.kind !== "group") {
        const said =
          event.content.type === "text"
            ? event.content.text
            : event.content.type === "button"
              ? event.content.text
              : null;
        const reply = optOutReply(said);
        if (reply === "stop")
          await tx
            .insert(schema.contactOptOut)
            .values({
              id: newId("contactOptOut"),
              organizationId: account.organizationId,
              contactId: identity.contactId,
              channelAccountId: account.id,
              source: "reply",
            })
            .onConflictDoNothing();
        if (reply === "start")
          await tx
            .delete(schema.contactOptOut)
            .where(
              and(
                eq(schema.contactOptOut.contactId, identity.contactId),
                eq(schema.contactOptOut.channelAccountId, account.id),
              ),
            );
      }

      await tx
        .update(schema.conversation)
        .set({
          status: "open",
          // The customer wrote: a snoozed conversation comes back now.
          snoozedUntil: null,
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

      // Automations hear about the message in the same transaction (Kairos rows commit with it).
      if (hooks.onInbound && !isReaction && event.conversation.kind !== "group" && conversation.contactId) {
        const c = event.content as {
          type: string;
          text?: string;
          caption?: string;
          title?: string;
          id?: string;
          kind?: string;
          payload?: string;
        };
        const said =
          c.type === "text"
            ? (c.text ?? "")
            : c.type === "button"
              ? (c.text ?? "")
              : c.type === "interactive"
                ? (c.title ?? "")
                : (c.caption ?? "");
        heard = true;
        await hooks.onInbound(tx, {
          messageId: id,
          organizationId: account.organizationId,
          branchId: conversation.branchId,
          channelAccountId: account.id,
          conversationId: conversation.id,
          contactId: conversation.contactId,
          type: c.type,
          text: said,
          reply:
            c.type === "interactive" && (c.kind === "button_reply" || c.kind === "list_reply") && c.id
              ? { id: c.id, title: c.title ?? "" }
              : c.type === "button" && c.payload
                ? { id: c.payload, title: c.text ?? "" }
                : null,
          adId: adIdOf(event.context.adReferral),
          optOut: optOutReply(said),
          location:
            event.content.type === "location"
              ? {
                  latitude: event.content.latitude,
                  longitude: event.content.longitude,
                  name: event.content.name,
                  address: event.content.address,
                }
              : null,
        });
      }

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
    if (heard) hooks.afterInbound?.();
    return saved;
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
          ...(next === "delivered" || next === "read" || next === "played"
            ? { deliveredAt: receipt?.deliveredAt ?? event.at }
            : {}),
          ...(next === "read" || next === "played" ? { readAt: receipt?.readAt ?? event.at } : {}),
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
      // A first play implies it was read; keep the earlier read time when there is one.
      played: { readAt: row.readAt ?? event.at, deliveredAt: row.deliveredAt ?? event.at },
      failed: { failedAt: event.at },
    }[next as "sent" | "delivered" | "read" | "played" | "failed"];
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
          inArray(schema.contactIdentity.scope, [
            ...new Set([identityScope(account.providerMeta, event.scope), event.scope]),
          ]),
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

  /**
   * A channel finished reviewing a template. Every channel copy with that id is updated (numbers that
   * share templates share the id).
   */
  async function templateReviewed(event: TemplateStatusEvent) {
    const decided = event.status === "ready" || event.status === "needs_changes";
    const rows = await db
      .update(schema.templateChannel)
      .set({
        status: event.status,
        reason: event.status === "ready" ? null : event.reason,
        error: null,
        ...(decided ? { decidedAt: event.at } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.templateChannel.externalId, event.templateExternalId))
      .returning({
        templateId: schema.templateChannel.templateId,
        organizationId: schema.templateChannel.organizationId,
      });
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.templateId)) continue;
      seen.add(r.templateId);
      changed.push({
        organizationId: r.organizationId,
        event: { type: "template.updated", templateId: r.templateId },
      });
    }
  }

  /**
   * A number's quality flag or the daily limit changed: kept on the channel accounts of that business
   * account (and number), where broadcasts read it.
   */
  async function accountHealth(event: AccountHealthEvent) {
    const ca = schema.channelAccount;
    const accounts = await db
      .select({ id: ca.id, displayPhone: ca.displayPhone, providerMeta: ca.providerMeta })
      .from(ca)
      .where(and(eq(ca.type, event.channel), sql`${ca.providerMeta} ->> 'wabaId' = ${event.scope}`));
    for (const a of accounts) {
      if (event.phone && (a.displayPhone ?? "").replace(/\D/g, "") !== event.phone) continue;
      const meta = {
        ...a.providerMeta,
        ...(event.dailyLimit !== undefined ? { messagingLimit: event.dailyLimit } : {}),
        ...(event.quality !== undefined ? { qualityFlag: event.quality } : {}),
        healthAt: event.at.toISOString(),
      };
      await db.update(ca).set({ providerMeta: meta, updatedAt: new Date() }).where(eq(ca.id, a.id));
    }
  }

  /*
   * WhatsApp coexistence: the business keeps the WhatsApp Business app on its phone. Its old chats
   * arrive once as "history", its contacts as "contacts.synced", and every reply typed on the phone as
   * an "echo". Imported messages are marked (content.via) so they never count as unread, reopen a
   * conversation, or send notifications.
   */
  const historyStatus: Record<string, StoredStatus> = {
    read: "read",
    played: "read",
    delivered: "delivered",
    sent: "sent",
    pending: "sent",
    error: "failed",
  };

  async function phoneAppMessage(account: Account, event: PhoneAppMessageEvent): Promise<string[]> {
    if (!event.externalId) return [];
    const identity = await upsertIdentity(account, event.customer);
    const history = event.source === "history";
    const conversation = await upsertDirectConversation(account, identity, { closed: history });
    const via = history ? "phone_app_history" : "phone_app";
    const content = { ...event.content, via } as Record<string, unknown>;
    const media = "media" in event.content && event.content.media.providerMediaId ? event.content : null;
    const outbound = event.direction === "outbound";
    const hours = windowHours(account, "direct");
    const window = !outbound && hours !== null ? windowExpiresAt(event.sentAt, hours) : null;

    return db.transaction(async (tx) => {
      const id = newId("message");
      const inserted = await tx
        .insert(schema.message)
        .values({
          id,
          organizationId: account.organizationId,
          conversationId: conversation.id,
          channelAccountId: account.id,
          direction: event.direction,
          senderType: outbound ? "user" : "contact",
          senderIdentityId: outbound ? null : identity.id,
          type: event.content.type,
          content,
          externalId: event.externalId,
          status: outbound ? (historyStatus[event.status ?? ""] ?? "sent") : "received",
          sentAt: event.sentAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.message.id });
      if (!inserted.length) return []; // Already imported (history can repeat; echoes of our own sends too).
      touched(conversation);
      await tx
        .update(schema.contact)
        .set({ lastMessageAt: latest(schema.contact.lastMessageAt, event.sentAt) })
        .where(eq(schema.contact.id, identity.contactId));
      await tx
        .update(schema.conversation)
        .set({
          lastMessageAt: latest(schema.conversation.lastMessageAt, event.sentAt),
          ...(!outbound ? { lastInboundAt: latest(schema.conversation.lastInboundAt, event.sentAt) } : {}),
          ...(window ? { windowExpiresAt: latest(schema.conversation.windowExpiresAt, window) } : {}),
          lastMessagePreview: sql`case when ${schema.conversation.lastMessageAt} is null or ${schema.conversation.lastMessageAt} <= ${event.sentAt.toISOString()}::timestamp then ${JSON.stringify(messagePreview(event.content.type, content, event.direction, null))}::jsonb else ${schema.conversation.lastMessagePreview} end`,
          updatedAt: new Date(),
        } as never)
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

  /** Adds the phone app's contacts to the number's branch (removals are ignored: we never delete people). */
  async function contactsSynced(account: Account, event: ContactsSyncedEvent) {
    let added = 0;
    for (const c of event.contacts) {
      if (c.action !== "add") continue;
      const identity = await upsertIdentity(account, {
        ...c.identity,
        profileName: c.fullName ?? c.identity.profileName,
      });
      if (c.fullName)
        await db
          .update(schema.contact)
          .set({ name: c.fullName, updatedAt: new Date() })
          .where(
            and(eq(schema.contact.id, identity.contactId), sql`coalesce(${schema.contact.name}, '') = ''`),
          );
      added++;
    }
    await setCoexistence(account.id, "contacts", { status: "done", imported: added });
  }

  /** History import progress: importing → done at 100, or declined when the business said no. */
  async function historyProgress(account: Account, event: HistoryProgressEvent) {
    if (event.errors.some((e) => e.code === 2593109)) {
      await setCoexistence(account.id, "history", {
        status: "declined",
        error: "The business turned off chat history sharing.",
      });
      return;
    }
    const ca = schema.channelAccount;
    const path = sql`'{coexistence,history}'`;
    const progress = event.progress ?? 0;
    await db
      .update(ca)
      .set({
        providerMeta: sql`jsonb_set(${ca.providerMeta}, ${path}, coalesce(${ca.providerMeta} #> ${path}, '{}'::jsonb) || jsonb_build_object(
          -- Chunks are processed in parallel: once any reached 100, the import stays done.
          'status', case when ${progress}::int >= 100 or coalesce(${ca.providerMeta} #>> '{coexistence,history,status}', '') = 'done'
            or coalesce((${ca.providerMeta} #>> '{coexistence,history,progress}')::int, 0) >= 100 then 'done' else 'importing' end,
          'progress', greatest(coalesce((${ca.providerMeta} #>> '{coexistence,history,progress}')::int, 0), ${progress}::int),
          'imported', coalesce((${ca.providerMeta} #>> '{coexistence,history,imported}')::int, 0) + ${event.messages}::int,
          'updatedAt', ${new Date().toISOString()}::text
        ), true)`,
        updatedAt: new Date(),
      } as never)
      .where(and(eq(ca.id, account.id), sql`${ca.providerMeta} ? 'coexistence'`));
  }

  async function setCoexistence(
    channelId: string,
    key: "contacts" | "history",
    patch: Record<string, unknown>,
  ) {
    const ca = schema.channelAccount;
    const path = sql.raw(`'{coexistence,${key}}'`);
    await db
      .update(ca)
      .set({
        providerMeta: sql`jsonb_set(${ca.providerMeta}, ${path}, coalesce(${ca.providerMeta} #> ${path}, '{}'::jsonb) || ${JSON.stringify({ ...patch, updatedAt: new Date().toISOString() })}::jsonb, true)`,
        updatedAt: new Date(),
      } as never)
      .where(and(eq(ca.id, channelId), sql`${ca.providerMeta} ? 'coexistence'`));
  }

  /**
   * Account news from Meta, matched to channels by business account (and number when given):
   * the business removed Relay or left the platform → disconnected and its broadcasts paused;
   * restrictions → a warning on the channel; display name and username decisions → kept.
   */
  async function accountUpdate(event: AccountEvent) {
    const ca = schema.channelAccount;
    const rows = await db
      .select({ id: ca.id, displayPhone: ca.displayPhone, externalId: ca.externalId, status: ca.status })
      .from(ca)
      .where(and(eq(ca.type, event.channel), sql`${ca.providerMeta} ->> 'wabaId' = ${event.scope}`));
    const data = event.data;
    const phoneOf = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");
    const forPhone = (digits: string) =>
      rows.filter((r) => !digits || (r.displayPhone ?? "").replace(/\D/g, "") === digits);
    const at = new Date().toISOString();
    const patchMeta = (id: string, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      db
        .update(ca)
        .set({
          providerMeta: sql`${ca.providerMeta} || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: new Date(),
          ...extra,
        } as never)
        .where(eq(ca.id, id));

    if (event.field === "account_update") {
      const what = typeof data.event === "string" ? data.event.toUpperCase() : "";
      const accountEvent = {
        event: what,
        at,
        detail: JSON.stringify(data.disconnection_info ?? data.restriction_info ?? data.violation_info ?? ""),
      };
      const gone = ["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED", "ACCOUNT_DELETED", "PARTNER_APP_UNINSTALLED"];
      const warn: Record<string, string> = {
        ACCOUNT_RESTRICTION: "Meta restricted this WhatsApp account. Check WhatsApp Manager.",
        ACCOUNT_VIOLATION:
          "Meta reported a policy violation on this WhatsApp account. Check WhatsApp Manager.",
        DISABLED_UPDATE: "Meta disabled this WhatsApp account. Check WhatsApp Manager.",
        ACCOUNT_RECONNECTED:
          "The number was reconnected in the WhatsApp Business app. Reconnect it in Relay to keep messaging.",
      };
      for (const r of rows) {
        if (gone.includes(what)) {
          if (r.status === "disconnected") continue;
          await patchMeta(
            r.id,
            { accountEvent },
            {
              status: "disconnected",
              statusReason:
                what === "ACCOUNT_OFFBOARDED"
                  ? "The business disconnected this number in the WhatsApp Business app."
                  : "The business removed Relay's access to this WhatsApp account in Meta.",
            },
          );
          await db
            .update(schema.broadcast)
            .set({
              status: "paused",
              pauseReason: "The WhatsApp number was disconnected",
              updatedAt: new Date(),
            } as never)
            .where(
              and(
                eq(schema.broadcast.channelAccountId, r.id),
                inArray(schema.broadcast.status, ["sending", "scheduled", "preparing"]),
              ),
            );
        } else if (warn[what]) {
          await patchMeta(
            r.id,
            { accountEvent },
            {
              statusReason: warn[what],
              ...(what === "ACCOUNT_RECONNECTED" || what === "DISABLED_UPDATE" ? { status: "error" } : {}),
            },
          );
        } else if (what) {
          await patchMeta(r.id, { accountEvent });
        }
        accounts.delete(`${event.channel}:${r.externalId}`);
      }
      return;
    }
    if (event.field === "phone_number_name_update") {
      const decision = typeof data.decision === "string" ? data.decision.toUpperCase() : null;
      for (const r of forPhone(phoneOf(data.display_phone_number))) {
        await patchMeta(
          r.id,
          {
            nameStatus: decision,
            ...(decision === "APPROVED" && typeof data.requested_verified_name === "string"
              ? { verifiedName: data.requested_verified_name }
              : {}),
          },
          decision === "APPROVED" && typeof data.requested_verified_name === "string"
            ? { displayName: data.requested_verified_name }
            : {},
        );
      }
      return;
    }
    if (event.field === "business_username_updates") {
      const username = typeof data.username === "string" ? data.username : null;
      for (const r of forPhone(phoneOf(data.display_phone_number))) await patchMeta(r.id, { username });
    }
    // Anything else stays in webhook_event only.
  }

  /** The customer edited or deleted a message they sent: the stored message follows, like WhatsApp. */
  async function editedOrRevoked(account: Account, event: MessageEditedEvent | MessageRevokedEvent) {
    const [row] = await db
      .select()
      .from(schema.message)
      .where(
        and(
          eq(schema.message.channelAccountId, account.id),
          eq(schema.message.externalId, event.targetExternalId),
        ),
      )
      .limit(1);
    if (!row) return; // Not in Relay (older than the connection): nothing to change.
    const old = row.content as Record<string, unknown>;
    const content =
      event.kind === "message.edited"
        ? {
            ...event.content,
            edited: true,
            editedAt: event.at.toISOString(),
            previous: old.text ?? old.caption ?? null,
          }
        : { type: row.type, deleted: true, deletedAt: event.at.toISOString() };
    await db.update(schema.message).set({ content }).where(eq(schema.message.id, row.id));
    await messageChanged(row);
  }

  /** Applies every event in one stored webhook. */
  async function ingest(events: NormalizedEvent[]): Promise<IngestResult> {
    changed = [];
    const result: IngestResult = { events: events.length, unrouted: 0, media: [], changed };
    for (const event of events) {
      if (event.kind === "template.status_changed") {
        await templateReviewed(event);
        continue;
      }
      if (event.kind === "template.quality_changed") {
        // Broadcasts read this (a RED template pauses them).
        await db
          .update(schema.templateChannel)
          .set({ quality: event.quality, updatedAt: new Date() })
          .where(eq(schema.templateChannel.externalId, event.templateExternalId));
        continue;
      }
      if (event.kind === "account.health") {
        await accountHealth(event);
        continue;
      }
      // Account news is about the business account; some carry no phone number id.
      if (event.kind === "account.update" && (!event.accountExternalId || event.field !== "errors")) {
        await accountUpdate(event);
        continue;
      }
      const account = await findAccount(event);
      if (!account) {
        result.unrouted++;
        continue;
      }
      if (event.kind === "message.received" || event.kind === "reaction")
        result.media.push(...(await received(account, event)));
      else if (event.kind === "message.status") await status(account, event);
      else if (event.kind === "contact.changed") await contactChanged(account, event);
      else if (event.kind === "message.edited" || event.kind === "message.revoked")
        await editedOrRevoked(account, event);
      else if (event.kind === "message.phone_app")
        result.media.push(...(await phoneAppMessage(account, event)));
      else if (event.kind === "contacts.synced") await contactsSynced(account, event);
      else if (event.kind === "history.progress") await historyProgress(account, event);
      else if (event.kind.startsWith("group.")) await groupEvent(account, event as GroupEvent);
      // account.update with errors only: kept in webhook_event.
    }
    return result;
  }

  return { ingest };
}

/** The ad id of a click-to-WhatsApp referral (Meta's source_id). */
function adIdOf(referral: Record<string, unknown> | null): string | null {
  const id = referral?.source_id;
  return typeof id === "string" && id ? id : null;
}
