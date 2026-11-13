import type { ChannelIdentity } from "@relay/channels";
import { newId } from "@relay/core";
import { and, asc, desc, eq, inArray, isNull, or, schema, sql } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import { accountRef, channels, providerFailure } from "../../channels";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type Access, type AccessEnv, branchAccess, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { reachableBranches } from "../conversations/routes";

/*
 * Group chats on any channel that has them. Everything goes through the channel's adapter and is
 * gated by its capabilities.groups, so this file never mentions a specific channel. Channels that
 * work asynchronously (WhatsApp) answer 202: the result arrives by webhook and the worker applies it.
 * Branch members can read; owners, admins and the branch's managers can change.
 */

const publicGroup = {
  id: schema.channelGroup.id,
  channelAccountId: schema.channelGroup.channelAccountId,
  channelType: schema.channelAccount.type,
  branchId: schema.channelGroup.branchId,
  externalId: schema.channelGroup.externalId,
  subject: schema.channelGroup.subject,
  description: schema.channelGroup.description,
  joinApprovalMode: schema.channelGroup.joinApprovalMode,
  status: schema.channelGroup.status,
  statusReason: schema.channelGroup.statusReason,
  participantCount: schema.channelGroup.participantCount,
  createdAt: schema.channelGroup.createdAt,
};

const createBody = z.object({
  channelId: z.string(),
  subject: z.string().trim().min(1, "subject is required").max(128),
  description: z.string().trim().max(2048).optional(),
  joinApproval: z.boolean().optional(),
  branchId: z.string().optional(),
});
const updateBody = z
  .object({
    subject: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(2048).optional(),
  })
  .refine(
    (b) => b.subject !== undefined || b.description !== undefined,
    "subject or description is required",
  );
const idsBody = z.object({ ids: z.array(z.string()).min(1).max(100) });

export function groupRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  /** Groups the caller may see, in the active business. */
  async function visible(access: Access) {
    const branches = await reachableBranches(ctx, access);
    const inOrg = eq(schema.channelGroup.organizationId, access.orgId);
    if (branches === null) return inOrg;
    if (!branches.length) return sql`false`;
    return and(inOrg, inArray(schema.channelGroup.branchId, branches));
  }

  async function load(access: Access, id: string) {
    const [row] = await ctx.db
      .select({ group: schema.channelGroup, account: schema.channelAccount })
      .from(schema.channelGroup)
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.channelGroup.channelAccountId))
      .where(and(eq(schema.channelGroup.id, id), await visible(access)))
      .limit(1);
    return row ?? null;
  }

  async function canManage(access: Access, branchId: string | null) {
    if (isOrgAdmin(access.orgRole)) return true;
    if (!branchId) return false;
    return (await branchAccess(ctx, access, branchId))?.role === "manager";
  }

  /** The loaded group and its channel's group adapter, or an error answer. */
  async function managed(c: Parameters<typeof fail>[0], access: Access, id: string) {
    const row = await load(access, id);
    if (!row) return { error: fail(c, 404, "not_found") };
    if (!(await canManage(access, row.group.branchId))) return { error: fail(c, 403, "forbidden") };
    const adapter = channels().get(row.account.type);
    if (!adapter?.groups || !adapter.capabilities.groups) {
      return { error: fail(c, 409, "not_supported", "This channel has no group chats.") };
    }
    if (row.account.status !== "active")
      return { error: fail(c, 409, "channel_unavailable", `The channel is ${row.account.status}.`) };
    return { row, groups: adapter.groups, capabilities: adapter.capabilities.groups };
  }

  app.get("/", async (c) => {
    const groups = await ctx.db
      .select(publicGroup)
      .from(schema.channelGroup)
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.channelGroup.channelAccountId))
      .where(and(await visible(c.var.access), isNull(schema.channelGroup.deletedAt)))
      .orderBy(desc(schema.channelGroup.createdAt));
    return c.json({ groups });
  });

  app.post("/", async (c) => {
    const access = c.var.access;
    const parsed = await parseBody(c, createBody);
    if ("error" in parsed) return parsed.error;
    const body = parsed.data;
    const [account] = await ctx.db
      .select()
      .from(schema.channelAccount)
      .where(
        and(
          eq(schema.channelAccount.id, body.channelId),
          eq(schema.channelAccount.organizationId, access.orgId),
        ),
      )
      .limit(1);
    if (!account) return fail(c, 404, "not_found", "Unknown channel.");
    const branchId = body.branchId ?? account.defaultBranchId;
    if (!(await canManage(access, branchId))) return fail(c, 403, "forbidden");
    if (branchId && body.branchId) {
      const linked = await ctx.db
        .select()
        .from(schema.channelAccountBranch)
        .where(
          and(
            eq(schema.channelAccountBranch.channelAccountId, account.id),
            eq(schema.channelAccountBranch.branchId, branchId),
          ),
        );
      if (!linked.length) return fail(c, 422, "invalid_input", "That branch does not use this channel.");
    }
    const adapter = channels().get(account.type);
    if (!adapter?.groups || !adapter.capabilities.groups?.canCreate) {
      return fail(c, 409, "not_supported", "This channel cannot create group chats.");
    }
    if (account.status !== "active")
      return fail(c, 409, "channel_unavailable", `The channel is ${account.status}.`);

    let result: Awaited<ReturnType<typeof adapter.groups.create>>;
    try {
      result = await adapter.groups.create(accountRef(account), body);
    } catch (err) {
      const answer = providerFailure(c, err);
      if (answer) return answer;
      throw err;
    }
    const id = newId("group");
    await ctx.db.insert(schema.channelGroup).values({
      id,
      organizationId: access.orgId,
      channelAccountId: account.id,
      branchId,
      externalId: result.groupExternalId ?? null,
      requestId: result.requestId,
      subject: body.subject,
      description: body.description ?? null,
      joinApprovalMode: body.joinApproval ? "approval_required" : "auto_approve",
      status: result.groupExternalId ? "active" : "creating",
    });
    const [group] = await ctx.db
      .select(publicGroup)
      .from(schema.channelGroup)
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.channelGroup.channelAccountId))
      .where(eq(schema.channelGroup.id, id));
    return c.json({ group }, result.groupExternalId ? 201 : 202);
  });

  app.get("/:id", async (c) => {
    const row = await load(c.var.access, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found");
    const [group] = await ctx.db
      .select(publicGroup)
      .from(schema.channelGroup)
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.channelGroup.channelAccountId))
      .where(eq(schema.channelGroup.id, row.group.id));
    const participants = await ctx.db
      .select({
        identityId: schema.contactIdentity.id,
        contactId: schema.contactIdentity.contactId,
        name: schema.contactIdentity.profileName,
        phone: schema.contactIdentity.phone,
        username: schema.contactIdentity.username,
        status: schema.groupParticipant.status,
        joinedAt: schema.groupParticipant.joinedAt,
        leftAt: schema.groupParticipant.leftAt,
      })
      .from(schema.groupParticipant)
      .innerJoin(
        schema.contactIdentity,
        eq(schema.contactIdentity.id, schema.groupParticipant.contactIdentityId),
      )
      .where(eq(schema.groupParticipant.groupId, row.group.id))
      .orderBy(asc(schema.groupParticipant.joinedAt));
    const joinRequests = await ctx.db
      .select({
        id: schema.groupJoinRequest.id,
        identityId: schema.contactIdentity.id,
        name: schema.contactIdentity.profileName,
        phone: schema.contactIdentity.phone,
        username: schema.contactIdentity.username,
        createdAt: schema.groupJoinRequest.createdAt,
      })
      .from(schema.groupJoinRequest)
      .innerJoin(
        schema.contactIdentity,
        eq(schema.contactIdentity.id, schema.groupJoinRequest.contactIdentityId),
      )
      .where(
        and(eq(schema.groupJoinRequest.groupId, row.group.id), eq(schema.groupJoinRequest.status, "pending")),
      );
    const [conversation] = await ctx.db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(eq(schema.conversation.groupId, row.group.id))
      .limit(1);
    return c.json({ group, participants, joinRequests, conversationId: conversation?.id ?? null });
  });

  app.patch("/:id", async (c) => {
    const parsed = await parseBody(c, updateBody);
    if ("error" in parsed) return parsed.error;
    const m = await managed(c, c.var.access, c.req.param("id"));
    if ("error" in m) return m.error;
    if (!m.capabilities.canRename) return fail(c, 409, "not_supported", "This channel cannot rename groups.");
    if (!m.row.group.externalId || m.row.group.status !== "active")
      return fail(c, 409, "group_unavailable", `The group is ${m.row.group.status}.`);
    try {
      const { requestId } = await m.groups.update(
        accountRef(m.row.account),
        m.row.group.externalId,
        parsed.data,
      );
      return c.json({ requestId, message: "Requested. The change shows once the channel confirms it." }, 202);
    } catch (err) {
      const answer = providerFailure(c, err);
      if (answer) return answer;
      throw err;
    }
  });

  app.delete("/:id", async (c) => {
    const m = await managed(c, c.var.access, c.req.param("id"));
    if ("error" in m) return m.error;
    if (!m.row.group.externalId)
      return fail(c, 409, "group_unavailable", `The group is ${m.row.group.status}.`);
    try {
      const { requestId } = await m.groups.delete(accountRef(m.row.account), m.row.group.externalId);
      return c.json(
        { requestId, message: "Requested. Everyone is removed once the channel confirms it." },
        202,
      );
    } catch (err) {
      const answer = providerFailure(c, err);
      if (answer) return answer;
      throw err;
    }
  });

  async function inviteLink(c: Parameters<typeof fail>[0], reset: boolean) {
    const m = await managed(c, c.var.access, c.req.param("id") ?? "");
    if ("error" in m) return m.error;
    if (!m.groups.inviteLink) return fail(c, 409, "not_supported", "This channel has no invite links.");
    if (!m.row.group.externalId || m.row.group.status !== "active")
      return fail(c, 409, "group_unavailable", `The group is ${m.row.group.status}.`);
    try {
      const link = await m.groups.inviteLink(accountRef(m.row.account), m.row.group.externalId, reset);
      await ctx.db
        .update(schema.channelGroup)
        .set({ inviteLink: link, updatedAt: new Date() })
        .where(eq(schema.channelGroup.id, m.row.group.id));
      return c.json({ inviteLink: link });
    } catch (err) {
      const answer = providerFailure(c, err);
      if (answer) return answer;
      throw err;
    }
  }
  app.get("/:id/invite-link", (c) => inviteLink(c, false));
  app.post("/:id/invite-link/reset", (c) => inviteLink(c, true));

  app.post("/:id/join-requests/:decision", async (c) => {
    const decision = c.req.param("decision");
    if (decision !== "approve" && decision !== "reject") return fail(c, 404, "not_found");
    const parsed = await parseBody(c, idsBody);
    if ("error" in parsed) return parsed.error;
    const m = await managed(c, c.var.access, c.req.param("id"));
    if ("error" in m) return m.error;
    if (!m.groups.decideJoinRequests)
      return fail(c, 409, "not_supported", "This channel has no join requests.");
    if (!m.row.group.externalId)
      return fail(c, 409, "group_unavailable", `The group is ${m.row.group.status}.`);
    const requests = await ctx.db
      .select()
      .from(schema.groupJoinRequest)
      .where(
        and(
          eq(schema.groupJoinRequest.groupId, m.row.group.id),
          eq(schema.groupJoinRequest.status, "pending"),
          inArray(schema.groupJoinRequest.id, parsed.data.ids),
        ),
      );
    if (!requests.length) return fail(c, 422, "invalid_input", "None of these join requests are pending.");
    try {
      await m.groups.decideJoinRequests(
        accountRef(m.row.account),
        m.row.group.externalId,
        requests.map((r) => r.externalId),
        decision === "approve",
      );
    } catch (err) {
      const answer = providerFailure(c, err);
      if (answer) return answer;
      throw err;
    }
    await ctx.db
      .update(schema.groupJoinRequest)
      .set({ status: decision === "approve" ? "approved" : "rejected", decidedAt: new Date() })
      .where(
        inArray(
          schema.groupJoinRequest.id,
          requests.map((r) => r.id),
        ),
      );
    return c.json({ decided: requests.length, decision });
  });

  app.delete("/:id/participants", async (c) => {
    const parsed = await parseBody(c, idsBody);
    if ("error" in parsed) return parsed.error;
    const m = await managed(c, c.var.access, c.req.param("id"));
    if ("error" in m) return m.error;
    if (!m.groups.removeParticipants || !m.capabilities.canRemoveParticipants) {
      return fail(c, 409, "not_supported", "This channel cannot remove people from groups.");
    }
    if (!m.row.group.externalId || m.row.group.status !== "active")
      return fail(c, 409, "group_unavailable", `The group is ${m.row.group.status}.`);
    const people = await ctx.db
      .select({ identity: schema.contactIdentity })
      .from(schema.groupParticipant)
      .innerJoin(
        schema.contactIdentity,
        eq(schema.contactIdentity.id, schema.groupParticipant.contactIdentityId),
      )
      .where(
        and(
          eq(schema.groupParticipant.groupId, m.row.group.id),
          eq(schema.groupParticipant.status, "active"),
          or(inArray(schema.contactIdentity.id, parsed.data.ids)),
        ),
      );
    if (!people.length) return fail(c, 422, "invalid_input", "None of these people are in the group.");
    const identities: ChannelIdentity[] = people.map(({ identity }) => ({
      externalId: identity.externalId,
      scope: identity.scope,
      phone: identity.phone,
      username: identity.username,
      profileName: identity.profileName,
    }));
    try {
      await m.groups.removeParticipants(accountRef(m.row.account), m.row.group.externalId, identities);
    } catch (err) {
      const answer = providerFailure(c, err);
      if (answer) return answer;
      throw err;
    }
    return c.json(
      {
        requested: identities.length,
        message: "Requested. They are marked removed once the channel confirms it.",
      },
      202,
    );
  });

  return app;
}
