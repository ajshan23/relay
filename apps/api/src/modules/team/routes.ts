import { newId } from "@relay/core";
import { isPermission, type Permission, permissionGroups } from "@relay/core/permissions";
import {
  and,
  asc,
  ensureBuiltInRoles,
  eq,
  inArray,
  isNull,
  loadCompanyAccess,
  rolePermissions,
  schema,
  sql,
} from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { invitationDays, queueInvitationEmail } from "../auth/auth";
import { requireSession } from "../auth/session";
import { type AccessEnv, can, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { checkGrants, grantInput, grantsOf, saveGrants } from "./grants";

/*
 * The team and its roles:
 *   GET    /api/team                       people, their access, pending invitations (team.view)
 *   PUT    /api/team/:userId/access        { grants } replaces someone's access (team.edit_access)
 *   DELETE /api/team/:userId               removes someone from the company (team.remove)
 *   POST   /api/team/invitations           { email, grants } invites someone with that access (team.invite)
 *   DELETE /api/team/invitations/:id       cancels an invitation (team.invite)
 *
 *   GET    /api/roles                      roles, what's in each, how many use it (team.view)
 *   POST   /api/roles                      { name, description, permissions } (roles.manage)
 *   PATCH  /api/roles/:id                  the company's own roles only (roles.manage)
 *   DELETE /api/roles/:id                  only when nobody uses it (roles.manage)
 *
 * Nobody changes their own access, the owner's access never changes, and nobody gives (or takes)
 * more than they hold.
 */

const grantsBody = z.object({ grants: z.array(grantInput).max(50) });

export function teamRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  /** Branches and numbers the access editor offers. */
  async function places(orgId: string) {
    const [branches, numbers] = await Promise.all([
      ctx.db
        .select({ id: schema.branch.id, name: schema.branch.name })
        .from(schema.branch)
        .where(and(eq(schema.branch.organizationId, orgId), isNull(schema.branch.archivedAt)))
        .orderBy(asc(schema.branch.createdAt)),
      ctx.db
        .select({
          id: schema.channelAccount.id,
          name: schema.channelAccount.displayName,
          phone: schema.channelAccount.displayPhone,
          type: schema.channelAccount.type,
          branchId: schema.channelAccount.branchId,
          status: schema.channelAccount.status,
        })
        .from(schema.channelAccount)
        .where(eq(schema.channelAccount.organizationId, orgId))
        .orderBy(asc(schema.channelAccount.createdAt)),
    ]);
    return { branches, numbers };
  }

  const shownGrant = (g: typeof schema.memberGrant.$inferSelect, roleName: string) => ({
    id: g.id,
    roleId: g.roleId,
    roleName,
    allBranches: g.allBranches,
    branchIds: g.branchIds,
    allNumbers: g.allNumbers,
    numberIds: g.numberIds,
  });

  app.get("/", async (c) => {
    const access = c.var.access;
    if (!can(access, "team.view")) return fail(c, 403, "forbidden");
    await ensureBuiltInRoles(ctx.db, access.orgId);
    const [people, grants, roles, invitations, invitationGrants] = await Promise.all([
      ctx.db
        .select({
          userId: schema.user.id,
          name: schema.user.name,
          email: schema.user.email,
          image: schema.user.image,
          memberRole: schema.member.role,
          joinedAt: schema.member.createdAt,
        })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, access.orgId))
        .orderBy(asc(schema.member.createdAt)),
      ctx.db.select().from(schema.memberGrant).where(eq(schema.memberGrant.organizationId, access.orgId)),
      ctx.db.select().from(schema.role).where(eq(schema.role.organizationId, access.orgId)),
      ctx.db
        .select()
        .from(schema.invitation)
        .where(
          and(eq(schema.invitation.organizationId, access.orgId), eq(schema.invitation.status, "pending")),
        )
        .orderBy(asc(schema.invitation.createdAt)),
      ctx.db
        .select()
        .from(schema.invitationGrant)
        .where(eq(schema.invitationGrant.organizationId, access.orgId)),
    ]);
    const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "Role";
    return c.json({
      people: people.map((p) => ({
        userId: p.userId,
        name: p.name,
        email: p.email,
        image: p.image ?? null,
        joinedAt: p.joinedAt,
        owner: p.memberRole.split(",").includes("owner"),
        you: p.userId === access.userId,
        grants: grants.filter((g) => g.userId === p.userId).map((g) => shownGrant(g, roleName(g.roleId))),
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        expired: i.expiresAt < new Date(),
        grants: invitationGrants
          .filter((g) => g.invitationId === i.id)
          .map((g) => ({
            ...shownGrant(
              { ...g, userId: "", createdByUserId: null, updatedAt: g.createdAt },
              roleName(g.roleId),
            ),
          })),
      })),
      roles: roles.map((r) => ({ id: r.id, name: r.name, builtIn: r.builtIn })),
      ...(await places(access.orgId)),
      canInvite: can(access, "team.invite"),
      canEditAccess: can(access, "team.edit_access"),
      canRemove: can(access, "team.remove"),
    });
  });

  app.put("/:userId/access", async (c) => {
    const access = c.var.access;
    if (!can(access, "team.edit_access")) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, grantsBody);
    if ("error" in parsed) return parsed.error;
    const userId = c.req.param("userId");
    if (userId === access.userId)
      return fail(c, 409, "own_access", "Ask someone else to change your access.");
    const [m] = await ctx.db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, access.orgId), eq(schema.member.userId, userId)))
      .limit(1);
    if (!m) return fail(c, 404, "not_found");
    if (m.role.split(",").includes("owner"))
      return fail(c, 409, "owner", "The owner always has full access.");
    const saved = await saveGrants(
      ctx,
      access,
      userId,
      await grantsOf(ctx, access.orgId, userId),
      parsed.data.grants,
    );
    if (!saved.ok) return fail(c, saved.status, saved.code, saved.message);
    return c.json({ ok: true });
  });

  app.delete("/:userId", async (c) => {
    const access = c.var.access;
    if (!can(access, "team.remove")) return fail(c, 403, "forbidden");
    const userId = c.req.param("userId");
    if (userId === access.userId) return fail(c, 409, "own_access", "You can't remove yourself.");
    const [m] = await ctx.db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, access.orgId), eq(schema.member.userId, userId)))
      .limit(1);
    if (!m) return fail(c, 404, "not_found");
    if (m.role.split(",").includes("owner")) return fail(c, 409, "owner", "The owner can't be removed.");
    // Removing someone takes everything they have: only people who hold all of it can do that.
    const everyone = await loadCompanyAccess(ctx.db, access.orgId);
    const theirs = everyone.find((a) => a.userId === userId);
    const more = theirs?.grants.some((g) => [...g.permissions].some((p) => !can(access, p)));
    if (more) return fail(c, 403, "forbidden", "They have access you don't have, so you can't remove them.");
    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(schema.memberGrant)
        .where(
          and(eq(schema.memberGrant.organizationId, access.orgId), eq(schema.memberGrant.userId, userId)),
        );
      await tx.delete(schema.member).where(eq(schema.member.id, m.id));
      // Unassign their open chats so nothing waits on someone who left.
      await tx
        .update(schema.conversation)
        .set({ assignedUserId: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.conversation.organizationId, access.orgId),
            eq(schema.conversation.assignedUserId, userId),
          ),
        );
    });
    return c.body(null, 204);
  });

  app.post("/invitations", async (c) => {
    const access = c.var.access;
    if (!can(access, "team.invite")) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({
        email: z.string().trim().toLowerCase().email("Enter an email address"),
        grants: grantsBody.shape.grants,
      }),
    );
    if ("error" in parsed) return parsed.error;
    const { email } = parsed.data;
    if (!parsed.data.grants.length)
      return fail(c, 422, "invalid_input", "Give them access to at least one branch.");
    const checked = await checkGrants(ctx, access, parsed.data.grants);
    if (!checked.ok) return fail(c, checked.status, checked.code, checked.message);
    const [already] = await ctx.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(and(eq(schema.member.organizationId, access.orgId), sql`lower(${schema.user.email}) = ${email}`))
      .limit(1);
    if (already) return fail(c, 409, "already_member", "They're already in your team.");
    const [org] = await ctx.db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, access.orgId));
    const [me] = await ctx.db
      .select({ name: schema.user.name, email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, access.userId));
    const id = newId("invitation");
    await ctx.db.transaction(async (tx) => {
      // A new invitation replaces an older one to the same email.
      await tx
        .update(schema.invitation)
        .set({ status: "canceled" })
        .where(
          and(
            eq(schema.invitation.organizationId, access.orgId),
            eq(schema.invitation.email, email),
            eq(schema.invitation.status, "pending"),
          ),
        );
      await tx.insert(schema.invitation).values({
        id,
        organizationId: access.orgId,
        email,
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + invitationDays * 24 * 3600_000),
        inviterId: access.userId,
      });
      await tx.insert(schema.invitationGrant).values(
        checked.grants.map((g) => ({
          id: newId("invitationGrant"),
          invitationId: id,
          organizationId: access.orgId,
          roleId: g.roleId,
          allBranches: g.allBranches,
          branchIds: g.branchIds,
          allNumbers: g.allNumbers,
          numberIds: g.numberIds,
        })),
      );
    });
    queueInvitationEmail({
      id,
      email,
      organizationId: access.orgId,
      organizationName: org?.name ?? "your team",
      inviterId: access.userId,
      inviterName: me?.name ?? "",
      inviterEmail: me?.email ?? "",
    });
    return c.json({ invitation: { id, email } }, 201);
  });

  app.delete("/invitations/:id", async (c) => {
    const access = c.var.access;
    if (!can(access, "team.invite")) return fail(c, 403, "forbidden");
    const res = await ctx.db
      .update(schema.invitation)
      .set({ status: "canceled" })
      .where(
        and(eq(schema.invitation.id, c.req.param("id")), eq(schema.invitation.organizationId, access.orgId)),
      )
      .returning({ id: schema.invitation.id });
    if (!res.length) return fail(c, 404, "not_found");
    return c.body(null, 204);
  });

  return app;
}

const roleBody = z.object({
  name: z.string().trim().min(1, "Name the role").max(60),
  description: z.string().trim().max(300).default(""),
  permissions: z.array(z.string()).max(200),
});

export function roleRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));
  const R = schema.role;

  /** A role can only hold what the person making it holds across the company. */
  function cleanPermissions(access: AccessEnv["Variables"]["access"], list: string[]) {
    const perms = [...new Set(list)].filter(isPermission) as Permission[];
    const extra = perms.filter((p) => !can(access, p));
    return { perms, extra };
  }

  app.get("/", async (c) => {
    const access = c.var.access;
    if (!can(access, "team.view")) return fail(c, 403, "forbidden");
    await ensureBuiltInRoles(ctx.db, access.orgId);
    const roles = await ctx.db
      .select()
      .from(R)
      .where(eq(R.organizationId, access.orgId))
      .orderBy(sql`${R.builtIn} is null`, asc(R.createdAt));
    const use = await ctx.db
      .select({
        roleId: schema.memberGrant.roleId,
        people: sql<number>`count(distinct ${schema.memberGrant.userId})::int`,
      })
      .from(schema.memberGrant)
      .where(eq(schema.memberGrant.organizationId, access.orgId))
      .groupBy(schema.memberGrant.roleId);
    return c.json({
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        builtIn: r.builtIn,
        permissions: rolePermissions(r),
        people: use.find((u) => u.roleId === r.id)?.people ?? 0,
      })),
      groups: permissionGroups,
      canManage: can(access, "roles.manage"),
    });
  });

  app.post("/", async (c) => {
    const access = c.var.access;
    if (!can(access, "roles.manage")) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, roleBody);
    if ("error" in parsed) return parsed.error;
    const { perms, extra } = cleanPermissions(access, parsed.data.permissions);
    if (extra.length) return fail(c, 403, "forbidden", "A role can only include what you can do yourself.");
    if (!perms.length) return fail(c, 422, "invalid_input", "Tick at least one permission.");
    const [row] = await ctx.db
      .insert(R)
      .values({
        id: newId("role"),
        organizationId: access.orgId,
        name: parsed.data.name,
        description: parsed.data.description,
        permissions: perms,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return fail(c, 409, "duplicate", "There's already a role with that name.");
    return c.json({ role: { ...row, permissions: perms, people: 0 } }, 201);
  });

  app.patch("/:id", async (c) => {
    const access = c.var.access;
    if (!can(access, "roles.manage")) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, roleBody.partial());
    if ("error" in parsed) return parsed.error;
    const [role] = await ctx.db
      .select()
      .from(R)
      .where(and(eq(R.id, c.req.param("id")), eq(R.organizationId, access.orgId)))
      .limit(1);
    if (!role) return fail(c, 404, "not_found");
    if (role.builtIn) return fail(c, 409, "built_in", "Built-in roles can't be changed. Copy it instead.");
    // Changing a role changes everyone who has it: only with everything it had and will have.
    const before = cleanPermissions(access, role.permissions);
    const after = parsed.data.permissions ? cleanPermissions(access, parsed.data.permissions) : before;
    if (before.extra.length || after.extra.length)
      return fail(c, 403, "forbidden", "A role can only include what you can do yourself.");
    if (!after.perms.length) return fail(c, 422, "invalid_input", "Tick at least one permission.");
    try {
      const [row] = await ctx.db
        .update(R)
        .set({
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          permissions: after.perms,
          updatedAt: new Date(),
        })
        .where(eq(R.id, role.id))
        .returning();
      return c.json({ role: { ...row, permissions: after.perms } });
    } catch (err) {
      if (String((err as { code?: string }).code) === "23505")
        return fail(c, 409, "duplicate", "There's already a role with that name.");
      throw err;
    }
  });

  app.delete("/:id", async (c) => {
    const access = c.var.access;
    if (!can(access, "roles.manage")) return fail(c, 403, "forbidden");
    const [role] = await ctx.db
      .select()
      .from(R)
      .where(and(eq(R.id, c.req.param("id")), eq(R.organizationId, access.orgId)))
      .limit(1);
    if (!role) return fail(c, 404, "not_found");
    if (role.builtIn) return fail(c, 409, "built_in", "Built-in roles can't be deleted.");
    const users = await ctx.db
      .selectDistinct({ name: schema.user.name })
      .from(schema.memberGrant)
      .innerJoin(schema.user, eq(schema.user.id, schema.memberGrant.userId))
      .where(eq(schema.memberGrant.roleId, role.id));
    if (users.length)
      return fail(
        c,
        409,
        "in_use",
        `${users
          .slice(0, 3)
          .map((u) => u.name)
          .join(
            ", ",
          )}${users.length > 3 ? ` and ${users.length - 3} more` : ""} still ${users.length === 1 ? "has" : "have"} this role. Change their access first.`,
      );
    await ctx.db.delete(R).where(eq(R.id, role.id));
    return c.body(null, 204);
  });

  void inArray;
  return app;
}
