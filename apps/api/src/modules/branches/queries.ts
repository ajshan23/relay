import {
  type Access,
  allPermissions,
  can,
  type Grant,
  type Permission,
  reachableBranchIds,
} from "@relay/core/permissions";
import { and, asc, eq, isNull, loadCompanyAccess, schema } from "@relay/db";
import type { AppContext } from "../../context";

type BranchRow = typeof schema.branch.$inferSelect;

const coversBranch = (g: Grant, branchId: string) => g.allBranches || g.branchIds.has(branchId);

/** What the person may do in a branch (on at least one of its numbers), for the web to show. */
export function branchPermissions(access: Access, branchId: string): Permission[] {
  return allPermissions.filter((p) => can(access, p, { branchId }));
}

/** A short name for the person's access in a branch: Owner, a role name, or several joined. */
export function branchRoleName(access: Access, branchId: string) {
  if (access.owner) return "Owner";
  const names = [...new Set(access.grants.filter((g) => coversBranch(g, branchId)).map((g) => g.roleName))];
  return names.join(", ") || null;
}

/** The Branch shape the API returns. */
export function toBranch(row: BranchRow, access: Access, memberCount: number) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    /** Changes with each new logo (?v=), so browsers can cache it. Null: show the initials. */
    logoUrl: row.logoFileId ? `/api/branches/${row.id}/logo?v=${row.logoFileId}` : null,
    role: branchRoleName(access, row.id),
    permissions: branchPermissions(access, row.id),
    createdAt: row.createdAt.toISOString(),
    memberCount,
  };
}

/** How many people can reach each branch (owners and all-branch grants count everywhere). */
async function memberCounts(ctx: AppContext, orgId: string, branchIds: string[]) {
  const everyone = await loadCompanyAccess(ctx.db, orgId);
  return new Map(
    branchIds.map((b) => [
      b,
      everyone.filter((a) => a.owner || a.grants.some((g) => coversBranch(g, b))).length,
    ]),
  );
}

/** Active branches the caller can reach, with what they may do there and the member count. */
export async function listBranches(ctx: AppContext, access: Access) {
  const reach = reachableBranchIds(access);
  const rows = await ctx.db
    .select()
    .from(schema.branch)
    .where(and(eq(schema.branch.organizationId, access.orgId), isNull(schema.branch.archivedAt)))
    .orderBy(asc(schema.branch.createdAt));
  const mine = rows.filter((r) => reach === "all" || reach.has(r.id));
  const counts = await memberCounts(
    ctx,
    access.orgId,
    mine.map((r) => r.id),
  );
  return mine.map((r) => toBranch(r, access, counts.get(r.id) ?? 0));
}

/** One branch as returned by the API, for a caller already known to reach it. */
export async function getBranch(ctx: AppContext, access: Access, branchId: string) {
  const [row] = await ctx.db
    .select()
    .from(schema.branch)
    .where(and(eq(schema.branch.id, branchId), eq(schema.branch.organizationId, access.orgId)));
  if (!row) return null;
  const counts = await memberCounts(ctx, access.orgId, [branchId]);
  return toBranch(row, access, counts.get(branchId) ?? 0);
}

/**
 * Everyone who can reach the branch, with the grants that reach it. `inherited`: their access
 * comes from the owner role or an all-branch grant, so it's changed in Team, not here.
 */
export async function listMembers(ctx: AppContext, orgId: string, branchId: string) {
  const everyone = await loadCompanyAccess(ctx.db, orgId);
  const people = await ctx.db
    .select({
      userId: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      image: schema.user.image,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(eq(schema.member.organizationId, orgId))
    .orderBy(asc(schema.member.createdAt));
  return people.flatMap((p) => {
    const a = everyone.find((x) => x.userId === p.userId);
    if (!a) return [];
    const grants = a.grants.filter((g) => coversBranch(g, branchId));
    if (!a.owner && !grants.length) return [];
    return [
      {
        ...p,
        image: p.image ?? null,
        owner: a.owner,
        role: a.owner ? "Owner" : [...new Set(grants.map((g) => g.roleName))].join(", "),
        grants: grants.map((g) => ({
          id: g.id,
          roleId: g.roleId,
          roleName: g.roleName,
          allBranches: g.allBranches,
          branchIds: [...g.branchIds],
          allNumbers: g.allNumbers,
          numberIds: [...g.numberIds],
        })),
        inherited: a.owner || grants.some((g) => g.allBranches || g.branchIds.size > 1),
      },
    ];
  });
}

/** True when the user is a member of the company. */
export async function isMember(ctx: AppContext, orgId: string, userId: string) {
  const [row] = await ctx.db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1);
  return !!row;
}
