import { and, asc, eq, isNull, schema, sql } from "@relay/db";
import type { AppContext } from "../../context";
import { type Access, type BranchRole, isOrgAdmin, type OrgRole, toOrgRole } from "./access";

type BranchRow = typeof schema.branch.$inferSelect;

/** The Branch shape the API returns. */
export function toBranch(row: BranchRow, role: BranchRole, memberCount: number) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    role,
    createdAt: row.createdAt.toISOString(),
    memberCount,
  };
}

const memberCount = sql<number>`(select count(*)::int from branch_member bm where bm.branch_id = "branch"."id")`;

/** Active branches the caller can reach, with their effective role and member count. */
export async function listBranches(ctx: AppContext, access: Access) {
  const active = and(eq(schema.branch.organizationId, access.orgId), isNull(schema.branch.archivedAt));
  if (isOrgAdmin(access.orgRole)) {
    const rows = await ctx.db
      .select({ branch: schema.branch, memberCount })
      .from(schema.branch)
      .where(active)
      .orderBy(asc(schema.branch.createdAt));
    return rows.map((r) => toBranch(r.branch, "manager", r.memberCount));
  }
  const rows = await ctx.db
    .select({ branch: schema.branch, role: schema.branchMember.role, memberCount })
    .from(schema.branch)
    .innerJoin(
      schema.branchMember,
      and(
        eq(schema.branchMember.branchId, schema.branch.id),
        eq(schema.branchMember.organizationId, access.orgId),
        eq(schema.branchMember.userId, access.userId),
      ),
    )
    .where(active)
    .orderBy(asc(schema.branch.createdAt));
  return rows.map((r) => toBranch(r.branch, r.role, r.memberCount));
}

/** One branch as returned by the API, for a caller already known to reach it. */
export async function getBranch(ctx: AppContext, access: Access, branchId: string, role: BranchRole) {
  const [row] = await ctx.db
    .select({ branch: schema.branch, memberCount })
    .from(schema.branch)
    .where(and(eq(schema.branch.id, branchId), eq(schema.branch.organizationId, access.orgId)));
  return row ? toBranch(row.branch, role, row.memberCount) : null;
}

/** Everyone who can reach the branch: organization owners/admins (inherited) plus members with a branch row. */
export async function listMembers(ctx: AppContext, orgId: string, branchId: string) {
  const userCols = {
    userId: schema.user.id,
    name: schema.user.name,
    email: schema.user.email,
    image: schema.user.image,
    orgRole: schema.member.role,
  };
  const admins = await ctx.db
    .select(userCols)
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(eq(schema.member.organizationId, orgId))
    .orderBy(asc(schema.member.createdAt));
  const rows = await ctx.db
    .select({ ...userCols, branchRole: schema.branchMember.role })
    .from(schema.branchMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.branchMember.userId))
    .innerJoin(
      schema.member,
      and(eq(schema.member.userId, schema.branchMember.userId), eq(schema.member.organizationId, orgId)),
    )
    .where(and(eq(schema.branchMember.branchId, branchId), eq(schema.branchMember.organizationId, orgId)))
    .orderBy(asc(schema.branchMember.createdAt));

  const inherited = admins
    .filter((m) => isOrgAdmin(toOrgRole(m.orgRole)))
    .map((m) => ({
      ...m,
      image: m.image ?? null,
      orgRole: toOrgRole(m.orgRole),
      branchRole: null,
      inherited: true,
    }));
  const direct = rows
    .filter((m) => !isOrgAdmin(toOrgRole(m.orgRole)))
    .map((m) => ({
      ...m,
      image: m.image ?? null,
      orgRole: toOrgRole(m.orgRole) as OrgRole,
      inherited: false,
    }));
  return [...inherited, ...direct];
}

/** The user's role in the organization, or null if they are not a member of it. */
export async function orgRoleOf(ctx: AppContext, orgId: string, userId: string) {
  const [row] = await ctx.db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1);
  return row ? toOrgRole(row.role) : null;
}
