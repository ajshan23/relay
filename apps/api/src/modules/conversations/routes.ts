import { type InboxEvent, messagePreview, newId, publishInboxEvent, type SignalJob } from "@relay/core";
import { fillVariables, type TemplateContent, templateVariables } from "@relay/core/templates";
import {
  AttachmentTaken,
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  insertOutboundMessage,
  isNull,
  or,
  schema,
  sql,
} from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import { channels } from "../../channels";
import type { AppContext } from "../../context";
import { enqueue } from "../../lib/enqueue";
import { requireSession } from "../auth/session";
import { type AccessEnv, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { requireBranch } from "../contacts/shared";
import {
  assignableUsers,
  type Conversation,
  canWork,
  findConversation,
  reachableBranches,
  visibleTo,
} from "./access";
import { startBody, startConversation } from "./start";

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

const views = ["open", "mine", "unassigned", "snoozed", "mentions", "closed", "all"] as const;
type View = (typeof views)[number];

/**
 * At most one "typing…" per conversation this often, however many people type in it. The browser
 * decides when (a real word, renewed every 20 s while typing); this only stops duplicates.
 */
const TYPING_EVERY_MS = 5_000;

const sendBody = z
  .object({
    text: z.string().trim().max(4096, "Messages can be up to 4096 characters").optional(),
    uploadId: z.string().optional(),
    /** The uploaded audio is a voice note recorded in Relay (sent as a WhatsApp voice message). */
    voice: z.boolean().optional(),
    /** Send a ready template, with a value for each of its details. Allowed outside the window. */
    templateId: z.string().optional(),
    values: z.record(z.string(), z.string().max(1000)).optional(),
    replyToMessageId: z.string().optional(),
  })
  .refine((b) => b.uploadId || b.text || b.templateId, { message: "Write a message or attach a file" });

const patchBody = z.object({
  assignedUserId: z.string().nullable().optional(),
  status: z.enum(["open", "closed"]).optional(),
  /** Hide from the open lists until then (ISO time, in the future); null wakes it now. */
  snoozedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
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

  const cv = schema.conversation;
  /** Snoozed until later: hidden from the open lists. Timestamps are stored as UTC. */
  const snoozed = sql`(${cv.snoozedUntil} is not null and ${cv.snoozedUntil} > (now() at time zone 'utc'))`;
  const awake = sql`not ${snoozed}`;
  const isOpen = and(eq(cv.status, "open"), awake);
  /** Conversations where this person was @mentioned in a note and hasn't looked yet. */
  const mentioned = (userId: string) =>
    sql`exists (select 1 from ${schema.mention} mn where mn.conversation_id = "conversation"."id" and mn.user_id = ${userId} and mn.read_at is null)`;

  function viewFilter(view: View, userId: string) {
    switch (view) {
      case "open":
        return isOpen;
      case "mine":
        return and(isOpen, eq(cv.assignedUserId, userId));
      case "unassigned":
        return and(isOpen, isNull(cv.assignedUserId));
      case "snoozed":
        return and(eq(cv.status, "open"), snoozed);
      case "mentions":
        return mentioned(userId);
      case "closed":
        return eq(schema.conversation.status, "closed");
      default:
        return undefined;
    }
  }

  /** Inbound messages newer than the caller last looked. Reactions and imported phone-app history do not count. */
  const unreadCount = sql<number>`(
    select count(*)::int from ${schema.message} m
    where m.conversation_id = ${schema.conversation.id}
      and m.direction = 'inbound' and m.type <> 'reaction'
      and coalesce(m.content ->> 'via', '') <> 'phone_app_history'
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
    // The inbox shows one branch at a time.
    const branchId = c.req.query("branch");
    if (!branchId || branchId === "all") return fail(c, 422, "branch_required", "Pick a branch.");
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
        snoozedUntil: schema.conversation.snoozedUntil,
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
          eq(schema.conversation.branchId, branchId),
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
            : (r.contactName ??
              r.profileName ??
              r.phone ??
              (r.username ? `@${r.username}` : null) ??
              "WhatsApp user"),
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
    // The inbox shows one branch at a time.
    const branchId = c.req.query("branch");
    if (!branchId || branchId === "all") return fail(c, 422, "branch_required", "Pick a branch.");
    const [row] = await ctx.db
      .select({
        open: sql<number>`count(*) filter (where ${isOpen})::int`,
        mine: sql<number>`count(*) filter (where ${isOpen} and ${cv.assignedUserId} = ${me})::int`,
        unassigned: sql<number>`count(*) filter (where ${isOpen} and ${cv.assignedUserId} is null)::int`,
        snoozed: sql<number>`count(*) filter (where ${cv.status} = 'open' and ${snoozed})::int`,
        mentions: sql<number>`count(*) filter (where ${mentioned(me)})::int`,
        closed: sql<number>`count(*) filter (where ${cv.status} = 'closed')::int`,
        unread: sql<number>`count(*) filter (where ${isOpen} and ${unreadCount} > 0)::int`,
      })
      .from(schema.conversation)
      .leftJoin(
        schema.conversationRead,
        and(
          eq(schema.conversationRead.conversationId, schema.conversation.id),
          eq(schema.conversationRead.userId, me),
        ),
      )
      .where(and(visibleTo(access, branches), eq(schema.conversation.branchId, branchId)));
    return c.json(row);
  });

  // Everything the conversation header and details panel show.
  // Start a chat from Relay (?branch=): finds or creates the contact, their WhatsApp identity and the chat.
  app.post("/start", requireBranch(ctx), async (c) => {
    const parsed = await parseBody(c, startBody);
    if ("error" in parsed) return parsed.error;
    const result = await startConversation(ctx, c.var.access, c.var.branchId, parsed.data);
    if (!result.ok) return fail(c, result.status, result.code, result.message);
    return c.json(
      { conversationId: result.conversationId, created: result.created },
      result.created ? 201 : 200,
    );
  });

  app.get("/:id", async (c) => {
    const access = c.var.access;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    const [[account], [branch], [assignee], contact, group, [myRead]] = await Promise.all([
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
      ctx.db
        .select({ at: schema.conversationRead.lastReadAt })
        .from(schema.conversationRead)
        .where(
          and(
            eq(schema.conversationRead.conversationId, conversation.id),
            eq(schema.conversationRead.userId, access.userId),
          ),
        )
        .limit(1),
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
        snoozedUntil:
          conversation.snoozedUntil && conversation.snoozedUntil > now ? conversation.snoozedUntil : null,
        /** When you last looked, for the "N unread messages" divider. Null when never. */
        myLastReadAt: myRead?.at ?? null,
        title:
          conversation.kind === "group"
            ? (group?.subject ?? "Group chat")
            : (contact?.name ??
              contact?.identities[0]?.profileName ??
              contact?.identities[0]?.phone ??
              (contact?.identities[0]?.username ? `@${contact.identities[0].username}` : null) ??
              "WhatsApp user"),
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
    const { assignedUserId, status, snoozedUntil } = parsed.data;
    const until = snoozedUntil ? new Date(snoozedUntil) : null;
    if (until && until.getTime() <= Date.now() + 30_000)
      return fail(c, 422, "invalid_input", "Pick a time in the future.");
    if (until && until.getTime() > Date.now() + 365 * 24 * 3600_000)
      return fail(c, 422, "invalid_input", "Snooze for up to a year.");
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
        // Closing ends a snooze; so does reopening.
        ...(snoozedUntil !== undefined
          ? { snoozedUntil: until, snoozedByUserId: until ? access.userId : null }
          : status
            ? { snoozedUntil: null, snoozedByUserId: null }
            : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.conversation.id, conversation.id))
      .returning();
    if (updated) await announce(updated);
    return c.json({ conversation: updated });
  });

  /**
   * Tells the customer's app that the team read their message ("read": blue ticks) or is typing a
   * reply ("typing"). Only for one-to-one chats, on channels that can, when the channel's "Show
   * customers when you've read and are typing" setting is on, and for people who can reply here.
   * Each customer message is marked read once; typing at most every TYPING_EVERY_MS per conversation.
   */
  async function customerSignal(
    access: AccessEnv["Variables"]["access"],
    conversation: typeof schema.conversation.$inferSelect,
    kind: "read" | "typing",
  ) {
    if (conversation.kind !== "direct") return false;
    if (kind === "typing" && !(conversation.windowExpiresAt && conversation.windowExpiresAt > new Date()))
      return false;
    const [account] = await ctx.db
      .select()
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, conversation.channelAccountId))
      .limit(1);
    if (account?.status !== "active" || account.settings.readReceipts === false) return false;
    const adapter = channels().get(account.type);
    if (!adapter?.markRead || !adapter.capabilities.readReceipts) return false;
    if (!(await canWork(ctx, access, conversation))) return false;
    const m = schema.message;
    const [newest] = await ctx.db
      .select({ id: m.id })
      .from(m)
      .where(
        and(
          eq(m.conversationId, conversation.id),
          eq(m.direction, "inbound"),
          sql`${m.externalId} is not null`,
        ),
      )
      .orderBy(desc(m.sentAt))
      .limit(1);
    if (!newest) return false;
    const cv = schema.conversation;
    // Moving the marker first means two people opening the chat at once queue one receipt.
    const moved = await ctx.db
      .update(cv)
      .set({ providerReadMessageId: newest.id })
      .where(
        and(
          eq(cv.id, conversation.id),
          kind === "read" ? sql`${cv.providerReadMessageId} is distinct from ${newest.id}` : undefined,
        ),
      )
      .returning({ id: cv.id });
    if (!moved.length) return false;
    const jobId =
      kind === "read"
        ? `read_${newest.id}`
        : `typing_${conversation.id}_${Math.floor(Date.now() / TYPING_EVERY_MS)}`;
    await enqueue(
      ctx.queues.signals,
      kind,
      { kind, conversationId: conversation.id, messageId: newest.id } satisfies SignalJob,
      {
        jobId,
        attempts: 2,
        backoff: { type: "fixed", delay: 2000 },
        removeOnComplete: { age: 60 },
        removeOnFail: { age: 3600 },
      },
    );
    return true;
  }

  /*
   * Internal notes: written in the conversation for the team only, never sent to the customer. Stored as
   * messages of type "note" (outbound, no external id, never queued), so they sit in the same timeline.
   * They don't move the conversation up the list or change its preview. "@[Name](userId)" mentions a
   * teammate who can work this branch; they see it under Mentions and get a live pop-up.
   */
  app.post("/:id/notes", async (c) => {
    const access = c.var.access;
    const parsed = await parseBody(c, z.object({ text: z.string().trim().min(1, "Write a note").max(4096) }));
    if ("error" in parsed) return parsed.error;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    if (!(await canWork(ctx, access, conversation)))
      return fail(c, 403, "forbidden", "Viewers can read conversations but not add notes.");
    const text = parsed.data.text;
    const asked = [...text.matchAll(/@\[[^\]]{1,80}\]\(([\w-]{1,60})\)/g)].map((m) => m[1] as string);
    const team = asked.length
      ? await assignableUsers(ctx, conversation.organizationId, conversation.branchId)
      : [];
    const mentions = [...new Set(asked)].filter(
      (id) => id !== access.userId && team.some((u) => u.id === id),
    );
    const id = newId("message");
    const now = new Date();
    await ctx.db.transaction(async (tx) => {
      await tx.insert(schema.message).values({
        id,
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        channelAccountId: conversation.channelAccountId,
        direction: "outbound",
        senderType: "user",
        senderUserId: access.userId,
        type: "note",
        content: { type: "note", text, mentions },
        status: "sent",
        sentAt: now,
      });
      if (mentions.length)
        await tx.insert(schema.mention).values(
          mentions.map((userId) => ({
            id: newId("mention"),
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            messageId: id,
            userId,
            byUserId: access.userId,
          })),
        );
    });
    await announce(conversation);
    const byName = c.var.user.name || c.var.user.email;
    for (const userId of mentions)
      await announce(conversation, {
        type: "mention",
        conversationId: conversation.id,
        branchId: conversation.branchId,
        userId,
        byName,
        messageId: id,
      });
    return c.json({ note: { id, mentions } }, 201);
  });

  app.delete("/:id/notes/:noteId", async (c) => {
    const access = c.var.access;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    const m = schema.message;
    const [note] = await ctx.db
      .select({ id: m.id, senderUserId: m.senderUserId })
      .from(m)
      .where(and(eq(m.id, c.req.param("noteId")), eq(m.conversationId, conversation.id), eq(m.type, "note")))
      .limit(1);
    if (!note) return fail(c, 404, "not_found");
    if (note.senderUserId !== access.userId && !isOrgAdmin(access.orgRole))
      return fail(
        c,
        403,
        "forbidden",
        "Only the person who wrote a note, or an owner or admin, can delete it.",
      );
    await ctx.db.delete(m).where(eq(m.id, note.id));
    await announce(conversation);
    return c.body(null, 204);
  });

  // The team member is typing a reply: show "typing…" on the customer's phone (see customerSignal).
  app.post("/:id/typing", async (c) => {
    const access = c.var.access;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    if (!(await canWork(ctx, access, conversation))) return fail(c, 403, "forbidden");
    await customerSignal(access, conversation, "typing").catch((err) => console.warn("typing signal", err));
    return c.body(null, 204);
  });

  // The caller has seen everything up to now. Unread counts are per person.
  app.post("/:id/read", async (c) => {
    const access = c.var.access;
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    const now = new Date();
    // When you looked before this, so the thread can mark where the new messages start.
    const [previous] = await ctx.db
      .select({ at: schema.conversationRead.lastReadAt })
      .from(schema.conversationRead)
      .where(
        and(
          eq(schema.conversationRead.conversationId, conversation.id),
          eq(schema.conversationRead.userId, access.userId),
        ),
      )
      .limit(1);
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
    // Opening the conversation is reading your @mentions in it.
    await ctx.db
      .update(schema.mention)
      .set({ readAt: now })
      .where(
        and(
          eq(schema.mention.conversationId, conversation.id),
          eq(schema.mention.userId, access.userId),
          isNull(schema.mention.readAt),
        ),
      );
    // And the customer sees blue ticks, when the channel allows it.
    await customerSignal(access, conversation, "read").catch((err) => console.warn("read signal", err));
    return c.json({ previousReadAt: previous?.at ?? null });
  });

  // Search this conversation's whole history: message text and media captions, notes included.
  app.get("/:id/messages/search", async (c) => {
    const conversation = await findConversation(ctx, c.var.access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    if (q.length < 2) return c.json({ matches: [] });
    const m = schema.message;
    const text = sql`(coalesce(${m.content} ->> 'text', '') || ' ' || coalesce(${m.content} -> 'media' ->> 'caption', ''))`;
    const rows = await ctx.db
      .select({
        id: m.id,
        sentAt: m.sentAt,
        type: m.type,
        direction: m.direction,
        text: sql<string>`${text}`,
      })
      .from(m)
      .where(
        and(
          eq(m.conversationId, conversation.id),
          sql`${m.type} <> 'reaction'`,
          sql`${text} ilike ${`%${q.replace(/[%_\\]/g, "\\$&")}%`}`,
        ),
      )
      .orderBy(desc(m.sentAt), desc(m.id))
      .limit(50);
    const lower = q.toLowerCase();
    return c.json({
      matches: rows.map((r) => {
        const t = r.text.trim();
        const at = t.toLowerCase().indexOf(lower);
        const from = Math.max(0, at - 40);
        const snippet = `${from > 0 ? "…" : ""}${t.slice(from, at + q.length + 60)}${at + q.length + 60 < t.length ? "…" : ""}`;
        return { id: r.id, sentAt: r.sentAt, type: r.type, direction: r.direction, snippet };
      }),
    });
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
              /** A small chat preview exists (GET /api/attachments/:id?preview=1). */
              hasPreview: sql<boolean>`${schema.storedFile.previewKey} is not null`,
              width: schema.storedFile.width,
              height: schema.storedFile.height,
            })
            .from(schema.attachment)
            .leftJoin(schema.storedFile, eq(schema.storedFile.id, schema.attachment.fileId))
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
              direction: schema.message.direction,
              status: schema.message.status,
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
    // One reaction per person per message; the business (everyone on the team) counts as one, as on WhatsApp.
    const reactionsOf = new Map<string, Map<string, { emoji: string; by: string | null; mine: boolean }>>();
    for (const r of reactions) {
      if (r.direction === "outbound" && r.status === "failed") continue;
      const content = r.content as { emoji?: string; targetMessageId?: string; targetExternalId?: string };
      const target = content.targetMessageId ?? byExternal.get(content.targetExternalId ?? "");
      if (!target) continue;
      const people = reactionsOf.get(target) ?? new Map();
      const mine = r.direction === "outbound";
      const who = mine ? "business" : (r.senderIdentityId ?? "?");
      if (content.emoji) people.set(who, { emoji: content.emoji, by: mine ? "You" : r.senderName, mine });
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
            ...(type === "audio" && parsed.data.voice ? { voice: true } : {}),
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

    let message: typeof schema.message.$inferSelect;
    try {
      ({ message } = await insertOutboundMessage(ctx.db, {
        id,
        conversation,
        type,
        content,
        senderType: "user",
        senderUserId: access.userId,
        senderName: user?.name ?? null,
        replyToMessageId,
        attachmentId: upload?.id ?? null,
        now,
      }));
    } catch (err) {
      if (err instanceof AttachmentTaken)
        return fail(c, 422, "invalid_upload", "That file was not found or was already sent.");
      throw err;
    }
    await enqueue(ctx.queues.outbox, "send", { messageId: id }, { jobId: id, ...outboxJobOptions });
    await announce(conversation);
    return c.json({ message }, 201);
  });

  // React to a message (or take our reaction away with an empty emoji). WhatsApp: within the reply
  // window, on messages up to 30 days old; the business has one reaction per message.
  app.post("/:id/messages/:messageId/react", async (c) => {
    const access = c.var.access;
    const parsed = await parseBody(c, z.object({ emoji: z.string().max(16) }));
    if ("error" in parsed) return parsed.error;
    const emoji = parsed.data.emoji.trim();
    const conversation = await findConversation(ctx, access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    if (!(await canWork(ctx, access, conversation)))
      return fail(c, 403, "forbidden", "Viewers can read conversations but not react.");
    const [account] = await ctx.db
      .select({ type: schema.channelAccount.type })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, conversation.channelAccountId))
      .limit(1);
    if (!account || !channels().get(account.type)?.capabilities.reactions)
      return fail(c, 422, "not_supported", "This channel doesn't take reactions.");
    if (!conversation.windowExpiresAt || conversation.windowExpiresAt <= new Date())
      return fail(
        c,
        409,
        "window_closed",
        "WhatsApp allows reactions only within 24 hours of the customer's last message.",
      );
    const [target] = await ctx.db
      .select()
      .from(schema.message)
      .where(
        and(
          eq(schema.message.id, c.req.param("messageId")),
          eq(schema.message.conversationId, conversation.id),
        ),
      )
      .limit(1);
    if (!target || target.type === "reaction") return fail(c, 404, "not_found");
    if (!target.externalId)
      return fail(
        c,
        409,
        "not_delivered",
        "That message hasn't reached WhatsApp yet, so it can't get a reaction.",
      );
    if (target.sentAt < new Date(Date.now() - 30 * 24 * 3600 * 1000))
      return fail(c, 409, "too_old", "WhatsApp allows reactions only on messages from the last 30 days.");

    const id = newId("message");
    const now = new Date();
    const content = {
      type: "reaction",
      emoji,
      targetMessageId: target.id,
      targetExternalId: target.externalId,
    };
    const [message] = await ctx.db
      .insert(schema.message)
      .values({
        id,
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        channelAccountId: conversation.channelAccountId,
        direction: "outbound",
        senderType: "user",
        senderUserId: access.userId,
        type: "reaction",
        content,
        status: "queued",
        sentAt: now,
      })
      .returning();
    await enqueue(ctx.queues.outbox, "send", { messageId: id }, { jobId: id, ...outboxJobOptions });
    await announce(conversation, {
      type: "message.updated",
      conversationId: conversation.id,
      branchId: conversation.branchId,
      messageId: target.id,
    });
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
    await enqueue(
      ctx.queues.outbox,
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
