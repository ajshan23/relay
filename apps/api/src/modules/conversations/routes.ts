import { type InboxEvent, messagePreview, newId, publishInboxEvent } from "@relay/core";
import { fillVariables, type TemplateContent, templateVariables } from "@relay/core/templates";
import { and, asc, desc, eq, ilike, inArray, isNull, or, schema, sql } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import { channels } from "../../channels";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import {
  assignableUsers,
  type Conversation,
  canWork,
  findConversation,
  reachableBranches,
  visibleTo,
} from "./access";

export { reachableBranches } from "./access";

/*
 * The inbox API: conversation list with views and unread counts, one conversation's details and
 * history, replies (text or a file), assignment, closing, and per-person read state.
 * Every change is announced on the organization's live channel (see @relay/core inbox.ts).
 */

/** Outbound jobs: the job id is the message id, so a message is never queued twice. */
export const outboxJobOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 3_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const;

const PAGE = 30;
const HISTORY_PAGE = 50;

/** Timestamps are stored as UTC without a zone; compare against an ISO string cast the same way. */
const utc = (iso: string) => sql`${iso}::timestamptz at time zone 'UTC'`;
/** Raw timestamps come back as strings (UTC without a zone) or Dates, depending on the driver path. */
const iso = (v: unknown) =>
  v instanceof Date
    ? v.toISOString()
    : new Date(`${String(v).replace(" ", "T").replace(/Z?$/, "Z")}`).toISOString();
const activityAt = sql`coalesce(${schema.conversation.lastMessageAt}, ${schema.conversation.createdAt})`;

const views = ["open", "mine", "unassigned", "closed", "all"] as const;
type View = (typeof views)[number];

const sendBody = z
  .object({
    text: z.string().trim().max(4096, "Messages can be up to 4096 characters").optional(),
    uploadId: z.string().optional(),
    /** Send a ready template, with a value for each of its details. Allowed outside the window. */
    templateId: z.string().optional(),
    values: z.record(z.string(), z.string().max(1000)).optional(),
    replyToMessageId: z.string().optional(),
  })
  .refine((b) => b.uploadId || b.text || b.templateId, { message: "Write a message or attach a file" });

const patchBody = z.object({
  assignedUserId: z.string().nullable().optional(),
  status: z.enum(["open", "closed"]).optional(),
});

export function conversationRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  const announce = (c: Conversation, event?: InboxEvent) =>
    publishInboxEvent(
      ctx.redis,
      c.organizationId,
      event ?? { type: "conversation.updated", conversationId: c.id, branchId: c.branchId },
    );

  function viewFilter(view: View, userId: string) {
    switch (view) {
      case "open":
        return eq(schema.conversation.status, "open");
      case "mine":
        return and(eq(schema.conversation.status, "open"), eq(schema.conversation.assignedUserId, userId));
      case "unassigned":
        return and(eq(schema.conversation.status, "open"), isNull(schema.conversation.assignedUserId));
      case "closed":
        return eq(schema.conversation.status, "closed");
      default:
        return undefined;
    }
  }

  /** Inbound messages newer than the caller last looked. Reactions do not count. */
  const unreadCount = sql<number>`(
    select count(*)::int from ${schema.message} m
    where m.conversation_id = ${schema.conversation.id}
      and m.direction = 'inbound' and m.type <> 'reaction'
      and m.sent_at > coalesce(${schema.conversationRead.lastReadAt}, '-infinity'::timestamp)
  )`;

  // ?view=open|mine|unassigned|closed|all  ?channel=<channel id>  ?q=<name, phone or group>  ?cursor=
  app.get("/", async (c) => {
    const access = c.var.access;
    const branches = await reachableBranches(ctx, access);
    const view = (views as readonly string[]).includes(c.req.query("view") ?? "")
      ? (c.req.query("view") as View)
      : "open";
    const channelId = c.req.query("channel");
    const branchId = c.req.query("branch");
    const q = c.req.query("q")?.trim();
    const cursor = c.req.query("cursor");
    const [cursorAt, cursorId] = cursor ? cursor.split("|") : [];
    const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;

    const rows = await ctx.db
      .select({
        id: schema.conversation.id,
        kind: schema.conversation.kind,
        status: schema.conversation.status,
        branchId: schema.conversation.branchId,
        channelId: schema.conversation.channelAccountId,
        channelType: schema.channelAccount.type,
        channelName: schema.channelAccount.displayName,
        contactName: schema.contact.name,
        profileName: schema.contactIdentity.profileName,
        phone: schema.contactIdentity.phone,
        username: schema.contactIdentity.username,
        groupSubject: schema.channelGroup.subject,
        groupStatus: schema.channelGroup.status,
        participantCount: schema.channelGroup.participantCount,
        assignedUserId: schema.conversation.assignedUserId,
        assigneeName: schema.user.name,
        assigneeImage: schema.user.image,
        preview: schema.conversation.lastMessagePreview,
        activityAt: sql<string>`${activityAt}`,
        windowExpiresAt: schema.conversation.windowExpiresAt,
        unreadCount,
      })
      .from(schema.conversation)
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.conversation.channelAccountId))
      // Direct chats have a contact; group chats have a group instead.
      .leftJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
      .leftJoin(schema.contactIdentity, eq(schema.contactIdentity.id, schema.conversation.contactIdentityId))
      .leftJoin(schema.channelGroup, eq(schema.channelGroup.id, schema.conversation.groupId))
      .leftJoin(schema.user, eq(schema.user.id, schema.conversation.assignedUserId))
      .leftJoin(
        schema.conversationRead,
        and(
          eq(schema.conversationRead.conversationId, schema.conversation.id),
          eq(schema.conversationRead.userId, access.userId),
        ),
      )
      .where(
        and(
          visibleTo(access, branches),
          viewFilter(view, access.userId),
          channelId ? eq(schema.conversation.channelAccountId, channelId) : undefined,
          branchId && branchId !== "all" ? eq(schema.conversation.branchId, branchId) : undefined,
          like
            ? or(
                ilike(schema.contact.name, like),
                ilike(schema.contactIdentity.profileName, like),
                ilike(schema.contactIdentity.phone, like),
                ilike(schema.contactIdentity.username, like),
                ilike(schema.channelGroup.subject, like),
              )
            : undefined,
          cursorAt && cursorId
            ? sql`(${activityAt}, ${schema.conversation.id}) < (${utc(cursorAt)}, ${cursorId})`
            : undefined,
        ),
      )
      .orderBy(desc(activityAt), desc(schema.conversation.id))
      .limit(PAGE + 1);

    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    const now = new Date();
    return c.json({
      conversations: page.map(({ assignedUserId, assigneeName, assigneeImage, activityAt, ...r }) => ({
        ...r,
        title:
          r.kind === "group"
            ? (r.groupSubject ?? "Group chat")
            : (r.contactName ?? r.profileName ?? r.phone ?? r.username ?? "Unknown"),
        activityAt: iso(activityAt),
        assignee: assignedUserId ? { id: assignedUserId, name: assigneeName, image: assigneeImage } : null,
        windowOpen: !!r.windowExpiresAt && r.windowExpiresAt > now,
      })),
      nextCursor: rows.length > PAGE && last ? `${iso(last.activityAt)}|${last.id}` : null,
    });
  });

  // How many conversations are in each view, and how many open ones have unread messages for the caller.
  app.get("/counts", async (c) => {
    const access = c.var.access;
    const branches = await reachableBranches(ctx, access);
    const me = access.userId;
    const branchId = c.req.query("branch");
    const [row] = await ctx.db
      .select({
        open: sql<number>`count(*) filter (where ${schema.conversation.status} = 'open')::int`,
        mine: sql<number>`count(*) filter (where ${schema.conversation.status} = 'open' and ${schema.conversation.assignedUserId} = ${me})::int`,
        unassigned: sql<number>`count(*) filter (where ${schema.conversation.status} = 'open' and ${schema.conversation.assignedUserId} is null)::int`,
        closed: sql<number>`count(*) filter (where ${schema.conversation.status} = 'closed')::int`,
        unread: sql<number>`count(*) filter (where ${schema.conversation.status} = 'open' and ${unreadCount} > 0)::int`,
      })
      .from(schema.conversation)
      .leftJoin(
        schema.conversationRead,
        and(
          eq(schema.conversationRead.conversationId, schema.conversation.id),
          eq(schema.conversationRead.userId, me),
        ),
      )
      .where(
        and(
          visibleTo(access, branches),
          branchId && branchId !== "all" ? eq(schema.conversation.branchId, branchId) : undefined,
        ),
      );
    return c.json(row);
  });

  // Everything the conversation header and details panel show.
  app.get("/:id", async (c) => {
    const access = c.var.access;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    const [[account], [branch], [assignee], contact, group] = await Promise.all([
      ctx.db
        .select()
        .from(schema.channelAccount)
        .where(eq(schema.channelAccount.id, conversation.channelAccountId))
        .limit(1),
      conversation.branchId
        ? ctx.db
            .select({ id: schema.branch.id, name: schema.branch.name })
            .from(schema.branch)
            .where(eq(schema.branch.id, conversation.branchId))
            .limit(1)
        : Promise.resolve([null]),
      conversation.assignedUserId
        ? ctx.db
            .select({ id: schema.user.id, name: schema.user.name, image: schema.user.image })
            .from(schema.user)
            .where(eq(schema.user.id, conversation.assignedUserId))
            .limit(1)
        : Promise.resolve([null]),
      conversation.contactId ? contactDetails(conversation.contactId) : Promise.resolve(null),
      conversation.groupId ? groupDetails(conversation.groupId) : Promise.resolve(null),
    ]);
    if (!account) return fail(c, 404, "not_found");
    const caps = channels().get(account.type)?.capabilities ?? null;
    const now = new Date();
    return c.json({
      conversation: {
        id: conversation.id,
        kind: conversation.kind,
        status: conversation.status,
        createdAt: conversation.createdAt,
        lastMessageAt: conversation.lastMessageAt,
        lastInboundAt: conversation.lastInboundAt,
        windowExpiresAt: conversation.windowExpiresAt,
        windowOpen: !!conversation.windowExpiresAt && conversation.windowExpiresAt > now,
        title:
          conversation.kind === "group"
            ? (group?.subject ?? "Group chat")
            : (contact?.name ??
              contact?.identities[0]?.profileName ??
              contact?.identities[0]?.phone ??
              "Unknown"),
      },
      channel: {
        id: account.id,
        type: account.type,
        name: account.displayName,
        phone: account.displayPhone,
        status: account.status,
      },
      capabilities: caps && {
        replyWindowHours:
          conversation.kind === "group" ? (caps.groups?.replyWindowHours ?? null) : caps.replyWindowHours,
        maxTextLength: caps.maxTextLength,
        media: caps.media,
        /** Message types this conversation can send (groups may allow fewer). */
        outboundTypes:
          conversation.kind === "group"
            ? (caps.groups?.outboundTypes ?? [])
            : ["text", "image", "video", "audio", "document", "sticker", "template"],
        reactions: caps.reactions,
        /** The channel has message templates (sendable outside the window once ready). */
        templates: !!caps.templates,
      },
      branch,
      assignee: assignee ?? null,
      contact,
      group,
      canWork: await canWork(ctx, access, conversation),
    });
  });

  async function contactDetails(contactId: string) {
    const [contact] = await ctx.db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, contactId))
      .limit(1);
    if (!contact) return null;
    const identities = await ctx.db
      .select({
        id: schema.contactIdentity.id,
        channelType: schema.contactIdentity.channelType,
        phone: schema.contactIdentity.phone,
        username: schema.contactIdentity.username,
        profileName: schema.contactIdentity.profileName,
      })
      .from(schema.contactIdentity)
      .where(eq(schema.contactIdentity.contactId, contactId))
      .orderBy(asc(schema.contactIdentity.createdAt));
    return { id: contact.id, name: contact.name, createdAt: contact.createdAt, identities };
  }

  async function groupDetails(groupId: string) {
    const [group] = await ctx.db
      .select({
        id: schema.channelGroup.id,
        subject: schema.channelGroup.subject,
        description: schema.channelGroup.description,
        status: schema.channelGroup.status,
        participantCount: schema.channelGroup.participantCount,
        joinApprovalMode: schema.channelGroup.joinApprovalMode,
      })
      .from(schema.channelGroup)
      .where(eq(schema.channelGroup.id, groupId))
      .limit(1);
    if (!group) return null;
    const participants = await ctx.db
      .select({
        identityId: schema.contactIdentity.id,
        name: sql<string | null>`coalesce(${schema.contact.name}, ${schema.contactIdentity.profileName})`,
        phone: schema.contactIdentity.phone,
        status: schema.groupParticipant.status,
        joinedAt: schema.groupParticipant.joinedAt,
        leftAt: schema.groupParticipant.leftAt,
      })
      .from(schema.groupParticipant)
      .innerJoin(
        schema.contactIdentity,
        eq(schema.contactIdentity.id, schema.groupParticipant.contactIdentityId),
      )
      .innerJoin(schema.contact, eq(schema.contact.id, schema.contactIdentity.contactId))
      .where(eq(schema.groupParticipant.groupId, groupId))
      .orderBy(asc(schema.groupParticipant.status), asc(schema.contactIdentity.profileName));
    return { ...group, participants };
  }

  // Teammates this conversation can be assigned to.
  app.get("/:id/assignees", async (c) => {
    const conversation = await findConversation(ctx, c.var.access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    return c.json({ users: await assignableUsers(ctx, conversation.organizationId, conversation.branchId) });
  });

  // Assign, unassign, close or reopen.
  app.patch("/:id", async (c) => {
    const access = c.var.access;
    const parsed = await parseBody(c, patchBody);
    if ("error" in parsed) return parsed.error;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    if (!(await canWork(ctx, access, conversation)))
      return fail(c, 403, "forbidden", "Viewers can read conversations but not change them.");
    const { assignedUserId, status } = parsed.data;
    if (assignedUserId) {
      const people = await assignableUsers(ctx, conversation.organizationId, conversation.branchId);
      if (!people.some((p) => p.id === assignedUserId))
        return fail(c, 422, "invalid_assignee", "That person can't work on this branch's conversations.");
    }
    const [updated] = await ctx.db
      .update(schema.conversation)
      .set({
        ...(assignedUserId !== undefined ? { assignedUserId } : {}),
        ...(status ? { status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.conversation.id, conversation.id))
      .returning();
    if (updated) await announce(updated);
    return c.json({ conversation: updated });
  });

  // The caller has seen everything up to now. Unread counts are per person.
  app.post("/:id/read", async (c) => {
    const access = c.var.access;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    const now = new Date();
    await ctx.db
      .insert(schema.conversationRead)
      .values({ userId: access.userId, conversationId: conversation.id, lastReadAt: now })
      .onConflictDoUpdate({
        target: [schema.conversationRead.userId, schema.conversationRead.conversationId],
        set: { lastReadAt: now },
      });
    await announce(conversation, {
      type: "conversation.read",
      conversationId: conversation.id,
      branchId: conversation.branchId,
      userId: access.userId,
    });
    return c.body(null, 204);
  });

  // History, newest page first. ?before=<message id> for older messages.
  app.get("/:id/messages", async (c) => {
    const conversation = await findConversation(ctx, c.var.access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    const beforeId = c.req.query("before");
    let before: { sentAt: Date; id: string } | null = null;
    if (beforeId) {
      const [row] = await ctx.db
        .select({ sentAt: schema.message.sentAt, id: schema.message.id })
        .from(schema.message)
        .where(and(eq(schema.message.id, beforeId), eq(schema.message.conversationId, conversation.id)))
        .limit(1);
      if (!row) return fail(c, 422, "invalid_input", "before is not a message of this conversation");
      before = row;
    }
    const rows = await ctx.db
      .select({
        id: schema.message.id,
        direction: schema.message.direction,
        senderType: schema.message.senderType,
        type: schema.message.type,
        content: schema.message.content,
        externalId: schema.message.externalId,
        status: schema.message.status,
        error: schema.message.error,
        replyToMessageId: schema.message.replyToMessageId,
        sentAt: schema.message.sentAt,
        deliveredAt: schema.message.deliveredAt,
        readAt: schema.message.readAt,
        senderIdentityId: schema.message.senderIdentityId,
        senderIdentityName: sql<
          string | null
        >`coalesce(${schema.contactIdentity.profileName}, ${schema.contactIdentity.phone})`,
        senderUserId: schema.message.senderUserId,
        senderUserName: schema.user.name,
      })
      .from(schema.message)
      .leftJoin(schema.contactIdentity, eq(schema.contactIdentity.id, schema.message.senderIdentityId))
      .leftJoin(schema.user, eq(schema.user.id, schema.message.senderUserId))
      .where(
        and(
          eq(schema.message.conversationId, conversation.id),
          sql`${schema.message.type} <> 'reaction'`,
          before
            ? sql`(${schema.message.sentAt}, ${schema.message.id}) < (${utc(before.sentAt.toISOString())}, ${before.id})`
            : undefined,
        ),
      )
      .orderBy(desc(schema.message.sentAt), desc(schema.message.id))
      .limit(HISTORY_PAGE + 1);
    const page = rows.slice(0, HISTORY_PAGE).reverse();
    const ids = page.map((m) => m.id);
    const externalIds = page.map((m) => m.externalId).filter((x): x is string => !!x);

    const [files, reactions, quoted, receipts] = ids.length
      ? await Promise.all([
          ctx.db
            .select({
              id: schema.attachment.id,
              messageId: schema.attachment.messageId,
              kind: schema.attachment.kind,
              mimeType: schema.attachment.mimeType,
              fileName: schema.attachment.fileName,
              sizeBytes: schema.attachment.sizeBytes,
              status: schema.attachment.status,
            })
            .from(schema.attachment)
            .where(inArray(schema.attachment.messageId, ids)),
          // Reactions: the latest one from each person counts; an empty emoji means they took it back.
          ctx.db
            .select({
              senderIdentityId: schema.message.senderIdentityId,
              senderName: sql<
                string | null
              >`coalesce(${schema.contactIdentity.profileName}, ${schema.contactIdentity.phone})`,
              content: schema.message.content,
              sentAt: schema.message.sentAt,
            })
            .from(schema.message)
            .leftJoin(schema.contactIdentity, eq(schema.contactIdentity.id, schema.message.senderIdentityId))
            .where(
              and(
                eq(schema.message.conversationId, conversation.id),
                eq(schema.message.type, "reaction"),
                or(
                  inArray(sql`${schema.message.content}->>'targetMessageId'`, ids),
                  externalIds.length
                    ? inArray(sql`${schema.message.content}->>'targetExternalId'`, externalIds)
                    : undefined,
                ),
              ),
            )
            .orderBy(asc(schema.message.sentAt)),
          ctx.db
            .select({
              id: schema.message.id,
              type: schema.message.type,
              content: schema.message.content,
              direction: schema.message.direction,
            })
            .from(schema.message)
            .where(
              inArray(
                schema.message.id,
                page
                  .map((m) => m.replyToMessageId)
                  .filter((x): x is string => !!x)
                  .concat("-"),
              ),
            ),
          conversation.kind === "group"
            ? ctx.db
                .select({
                  messageId: schema.messageReceipt.messageId,
                  delivered: sql<number>`count(*) filter (where ${schema.messageReceipt.status} in ('delivered', 'read'))::int`,
                  read: sql<number>`count(*) filter (where ${schema.messageReceipt.status} = 'read')::int`,
                })
                .from(schema.messageReceipt)
                .where(inArray(schema.messageReceipt.messageId, ids))
                .groupBy(schema.messageReceipt.messageId)
            : Promise.resolve([]),
        ])
      : [[], [], [], []];

    const byExternal = new Map(page.filter((m) => m.externalId).map((m) => [m.externalId, m.id]));
    const reactionsOf = new Map<string, Map<string, { emoji: string; by: string | null }>>();
    for (const r of reactions) {
      const content = r.content as { emoji?: string; targetMessageId?: string; targetExternalId?: string };
      const target = content.targetMessageId ?? byExternal.get(content.targetExternalId ?? "");
      if (!target) continue;
      const people = reactionsOf.get(target) ?? new Map();
      const who = r.senderIdentityId ?? "?";
      if (content.emoji) people.set(who, { emoji: content.emoji, by: r.senderName });
      else people.delete(who);
      reactionsOf.set(target, people);
    }

    return c.json({
      messages: page.map((m) => ({
        id: m.id,
        direction: m.direction,
        senderType: m.senderType,
        sender:
          m.direction === "inbound"
            ? { kind: "contact", id: m.senderIdentityId, name: m.senderIdentityName }
            : m.senderUserId
              ? { kind: "user", id: m.senderUserId, name: m.senderUserName }
              : { kind: m.senderType, id: null, name: null },
        type: m.type,
        content: m.content,
        status: m.status,
        error: m.error,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        readAt: m.readAt,
        attachments: files
          .filter((f) => f.messageId === m.id)
          .map(({ messageId: _, ...f }) => ({ ...f, url: `/api/attachments/${f.id}` })),
        reactions: [...(reactionsOf.get(m.id)?.values() ?? [])],
        replyTo: (() => {
          const q = quoted.find((x) => x.id === m.replyToMessageId);
          return q ? { id: q.id, ...messagePreview(q.type, q.content, q.direction) } : null;
        })(),
        receipts: receipts.find((r) => r.messageId === m.id) ?? null,
      })),
      nextBefore: rows.length > HISTORY_PAGE ? (page[0]?.id ?? null) : null,
    });
  });

  // Reply with text or a file uploaded first through POST /api/uploads. Sent by the worker.
  app.post("/:id/messages", async (c) => {
    const access = c.var.access;
    const parsed = await parseBody(c, sendBody);
    if ("error" in parsed) return parsed.error;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    if (!(await canWork(ctx, access, conversation)))
      return fail(c, 403, "forbidden", "Viewers can read conversations but not reply.");
    const templateId = parsed.data.templateId;
    if (!templateId && (!conversation.windowExpiresAt || conversation.windowExpiresAt <= new Date())) {
      return fail(
        c,
        409,
        "window_closed",
        "The reply window has closed. Only an approved template can be sent now.",
      );
    }
    const [account] = await ctx.db
      .select()
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, conversation.channelAccountId))
      .limit(1);
    const caps = account ? channels().get(account.type)?.capabilities : null;
    if (!account || !caps)
      return fail(c, 409, "unsupported_channel", "Replies on this channel aren't built yet.");
    const allowed =
      conversation.kind === "group"
        ? (caps.groups?.outboundTypes ?? [])
        : ["text", "image", "video", "audio", "document", "sticker", "template"];

    const { text, uploadId } = parsed.data;
    if (text && text.length > caps.maxTextLength)
      return fail(
        c,
        422,
        "too_long",
        `Messages on this channel can be up to ${caps.maxTextLength} characters.`,
      );

    let upload: typeof schema.attachment.$inferSelect | null = null;
    if (uploadId) {
      const [row] = await ctx.db
        .select()
        .from(schema.attachment)
        .where(
          and(
            eq(schema.attachment.id, uploadId),
            eq(schema.attachment.organizationId, conversation.organizationId),
            isNull(schema.attachment.messageId),
          ),
        )
        .limit(1);
      if (!row) return fail(c, 422, "invalid_upload", "That file was not found or was already sent.");
      upload = row;
    }
    // A template: it must be ready on this conversation's channel, with every detail filled in.
    let templateContent: Record<string, unknown> | null = null;
    if (templateId) {
      const [row] = await ctx.db
        .select({ template: schema.messageTemplate, copy: schema.templateChannel })
        .from(schema.messageTemplate)
        .innerJoin(
          schema.templateChannel,
          and(
            eq(schema.templateChannel.templateId, schema.messageTemplate.id),
            eq(schema.templateChannel.channelAccountId, conversation.channelAccountId),
          ),
        )
        .where(
          and(
            eq(schema.messageTemplate.id, templateId),
            eq(schema.messageTemplate.organizationId, conversation.organizationId),
          ),
        )
        .limit(1);
      if (!row)
        return fail(c, 422, "template_not_on_channel", "That template isn't published on this channel.");
      if (row.copy.status !== "ready")
        return fail(c, 409, "template_not_ready", "That template isn't approved on this channel yet.");
      const tc = row.template.content as unknown as TemplateContent;
      const values: Record<string, string> = {};
      const missing: string[] = [];
      for (const name of templateVariables(tc)) {
        const v = parsed.data.values?.[name]?.trim();
        if (v) values[name] = v;
        else missing.push(name.replace(/_/g, " "));
      }
      if (missing.length) return fail(c, 422, "missing_values", `Fill in: ${missing.join(", ")}.`);
      templateContent = {
        type: "template",
        templateId: row.template.id,
        templateName: row.template.name,
        name: row.template.slug,
        language: row.template.language,
        values,
        header:
          tc.header?.kind === "text"
            ? { kind: "text", text: fillVariables(tc.header.text, values) }
            : (tc.header ?? null),
        body: fillVariables(tc.body, values),
        footer: tc.footer,
        buttons: tc.buttons,
        auth: !!tc.auth,
      };
    }

    const type = templateContent ? "template" : upload ? upload.kind : "text";
    if (!allowed.includes(type))
      return fail(c, 422, "unsupported_type", `This conversation can't receive ${type} messages.`);

    let replyToMessageId: string | null = null;
    if (parsed.data.replyToMessageId) {
      const [target] = await ctx.db
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.id, parsed.data.replyToMessageId),
            eq(schema.message.conversationId, conversation.id),
          ),
        )
        .limit(1);
      if (!target) return fail(c, 422, "invalid_input", "replyToMessageId is not in this conversation");
      replyToMessageId = target.id;
    }

    const now = new Date();
    const id = newId("message");
    const content: Record<string, unknown> = templateContent
      ? templateContent
      : upload
        ? {
            type,
            caption: text ?? null,
            media: {
              providerMediaId: null,
              mimeType: upload.mimeType,
              fileName: upload.fileName,
              sha256: upload.sha256,
              caption: text ?? null,
            },
          }
        : { type: "text", text };
    const [user] = await ctx.db
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, access.userId))
      .limit(1);

    const message = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.message)
        .values({
          id,
          organizationId: conversation.organizationId,
          conversationId: conversation.id,
          channelAccountId: conversation.channelAccountId,
          direction: "outbound",
          senderType: "user",
          senderUserId: access.userId,
          type,
          content,
          status: "queued",
          replyToMessageId,
          sentAt: now,
        })
        .returning();
      if (upload) {
        const linked = await tx
          .update(schema.attachment)
          .set({ messageId: id })
          .where(and(eq(schema.attachment.id, upload.id), isNull(schema.attachment.messageId)))
          .returning({ id: schema.attachment.id });
        if (!linked.length) throw new Error("upload already used");
      }
      await tx
        .update(schema.conversation)
        .set({
          lastMessageAt: now,
          lastMessagePreview: messagePreview(type, content, "outbound", user?.name ?? null),
          updatedAt: now,
        })
        .where(eq(schema.conversation.id, conversation.id));
      return row;
    });
    await ctx.queues.outbox.add("send", { messageId: id }, { jobId: id, ...outboxJobOptions });
    await announce(conversation);
    return c.json({ message }, 201);
  });

  // Try a failed message again. Messages that may already have gone out need confirm: true.
  app.post("/:id/messages/:messageId/retry", async (c) => {
    const access = c.var.access;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    if (!(await canWork(ctx, access, conversation))) return fail(c, 403, "forbidden");
    const [message] = await ctx.db
      .select()
      .from(schema.message)
      .where(
        and(
          eq(schema.message.id, c.req.param("messageId")),
          eq(schema.message.conversationId, conversation.id),
        ),
      )
      .limit(1);
    if (!message || message.direction !== "outbound") return fail(c, 404, "not_found");
    if (message.status !== "failed")
      return fail(c, 409, "not_failed", "Only failed messages can be sent again.");
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
    if ((message.error as { reason?: string } | null)?.reason === "unknown" && !body.confirm)
      return fail(
        c,
        409,
        "may_be_sent",
        "This message may already have been delivered. Send it again anyway?",
      );
    if (!conversation.windowExpiresAt || conversation.windowExpiresAt <= new Date())
      return fail(c, 409, "window_closed", "The reply window has closed.");
    await ctx.db
      .update(schema.message)
      .set({ status: "queued", error: null, failedAt: null })
      .where(and(eq(schema.message.id, message.id), eq(schema.message.status, "failed")));
    // A new job id: the first job's id stays reserved by the queue for a week.
    await ctx.queues.outbox.add(
      "send",
      { messageId: message.id },
      { jobId: `${message.id}.retry.${Date.now()}`, ...outboxJobOptions },
    );
    await announce(conversation, {
      type: "message.updated",
      conversationId: conversation.id,
      branchId: conversation.branchId,
      messageId: message.id,
    });
    return c.json({ ok: true });
  });

  return app;
}
