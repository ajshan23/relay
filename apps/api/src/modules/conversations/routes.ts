import { newId } from "@relay/core";
import { and, desc, eq, inArray, isNull, lt, or, schema, sql } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type Access, type AccessEnv, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";

/*
 * Conversations and messages (plumbing for now; the inbox screens come in step 4).
 * Who sees what follows the branch rules: owners and admins every branch, members only the
 * branches they are added to. A conversation without a branch is visible to owners and admins only.
 */

/** Branch ids the caller can reach, or null for "all" (owners and admins). */
async function reachableBranches(ctx: AppContext, access: Access): Promise<string[] | null> {
  if (isOrgAdmin(access.orgRole)) return null;
  const rows = await ctx.db
    .select({ id: schema.branchMember.branchId })
    .from(schema.branchMember)
    .where(
      and(
        eq(schema.branchMember.organizationId, access.orgId),
        eq(schema.branchMember.userId, access.userId),
      ),
    );
  return rows.map((r) => r.id);
}

function visibleTo(access: Access, branches: string[] | null) {
  const inOrg = eq(schema.conversation.organizationId, access.orgId);
  if (branches === null) return inOrg;
  if (!branches.length) return sql`false`;
  return and(inOrg, inArray(schema.conversation.branchId, branches));
}

/** One conversation the caller may see, or null. Never reveals conversations of other organizations. */
async function findConversation(ctx: AppContext, access: Access, id: string) {
  const branches = await reachableBranches(ctx, access);
  const [row] = await ctx.db
    .select()
    .from(schema.conversation)
    .where(and(eq(schema.conversation.id, id), visibleTo(access, branches)))
    .limit(1);
  return row ?? null;
}

/** Outbound jobs: the job id is the message id, so a message is never queued twice. */
export const outboxJobOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 3_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const;

const sendBody = z.object({
  text: z.string().trim().min(1, "text is required").max(4096, "WhatsApp allows up to 4096 characters"),
  replyToMessageId: z.string().optional(),
});

export function conversationRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  // Newest first. ?before=<ISO time> for the next page.
  app.get("/", async (c) => {
    const access = c.var.access;
    const branches = await reachableBranches(ctx, access);
    const before = c.req.query("before");
    const rows = await ctx.db
      .select({
        id: schema.conversation.id,
        status: schema.conversation.status,
        branchId: schema.conversation.branchId,
        channelAccountId: schema.conversation.channelAccountId,
        channelType: schema.channelAccount.type,
        channelName: schema.channelAccount.displayName,
        kind: schema.conversation.kind,
        contactId: schema.conversation.contactId,
        contactName: schema.contact.name,
        phone: schema.contactIdentity.phone,
        groupId: schema.conversation.groupId,
        groupSubject: schema.channelGroup.subject,
        lastMessageAt: schema.conversation.lastMessageAt,
        windowExpiresAt: schema.conversation.windowExpiresAt,
      })
      .from(schema.conversation)
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.conversation.channelAccountId))
      // Direct chats have a contact; group chats have a group instead.
      .leftJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
      .leftJoin(schema.contactIdentity, eq(schema.contactIdentity.id, schema.conversation.contactIdentityId))
      .leftJoin(schema.channelGroup, eq(schema.channelGroup.id, schema.conversation.groupId))
      .where(
        and(
          visibleTo(access, branches),
          before
            ? or(
                lt(schema.conversation.lastMessageAt, new Date(before)),
                isNull(schema.conversation.lastMessageAt),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.conversation.lastMessageAt))
      .limit(50);
    return c.json({
      conversations: rows.map((r) => ({
        ...r,
        windowOpen: !!r.windowExpiresAt && r.windowExpiresAt > new Date(),
      })),
    });
  });

  app.get("/:id/messages", async (c) => {
    const conversation = await findConversation(ctx, c.var.access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    const messages = await ctx.db
      .select({
        id: schema.message.id,
        direction: schema.message.direction,
        senderType: schema.message.senderType,
        senderUserId: schema.message.senderUserId,
        senderIdentityId: schema.message.senderIdentityId,
        type: schema.message.type,
        content: schema.message.content,
        status: schema.message.status,
        error: schema.message.error,
        replyToMessageId: schema.message.replyToMessageId,
        sentAt: schema.message.sentAt,
        deliveredAt: schema.message.deliveredAt,
        readAt: schema.message.readAt,
      })
      .from(schema.message)
      .where(eq(schema.message.conversationId, conversation.id))
      .orderBy(desc(schema.message.sentAt))
      .limit(100);
    return c.json({ conversation, messages: messages.reverse() });
  });

  // Reply with text. Recorded as queued and sent by the worker.
  app.post("/:id/messages", async (c) => {
    const parsed = await parseBody(c, sendBody);
    if ("error" in parsed) return parsed.error;
    const conversation = await findConversation(ctx, c.var.access, c.req.param("id"));
    if (!conversation) return fail(c, 404, "not_found");
    if (!conversation.windowExpiresAt || conversation.windowExpiresAt <= new Date()) {
      return fail(
        c,
        409,
        "window_closed",
        "The 24-hour reply window has closed. Only an approved template can be sent now.",
      );
    }
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
    const [message] = await ctx.db
      .insert(schema.message)
      .values({
        id,
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        channelAccountId: conversation.channelAccountId,
        direction: "outbound",
        senderType: "user",
        senderUserId: c.var.access.userId,
        type: "text",
        content: { type: "text", text: parsed.data.text },
        status: "queued",
        replyToMessageId,
        sentAt: now,
      })
      .returning();
    await ctx.db
      .update(schema.conversation)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(schema.conversation.id, conversation.id));
    await ctx.queues.outbox.add("send", { messageId: id }, { jobId: id, ...outboxJobOptions });
    return c.json({ message }, 201);
  });

  return app;
}
