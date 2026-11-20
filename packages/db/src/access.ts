import { newId } from "@relay/core";
import {
  type Access,
  type BuiltInRole,
  builtInRoleKeys,
  builtInRoles,
  type Grant,
  isPermission,
  type Permission,
} from "@relay/core/permissions";
import { and, eq, inArray } from "drizzle-orm";
import type { createDb } from "./client";
import { invitationGrant, member, memberGrant, role } from "./schema";

/*
 * Loading who may do what (see @relay/core/permissions): the person's grants with their roles'
 * permissions. Built-in roles take their permissions from code, so Admin always has everything.
 */

type Db = ReturnType<typeof createDb>["db"];
export type RoleRow = typeof role.$inferSelect;
export type GrantRow = typeof memberGrant.$inferSelect;

/** A role's permissions: from code for the built-in ones, else the stored list (unknown keys dropped). */
export function rolePermissions(r: Pick<RoleRow, "builtIn" | "permissions">): Permission[] {
  if (r.builtIn) return builtInRoles[r.builtIn].permissions;
  return r.permissions.filter(isPermission);
}

export const isOwnerRole = (memberRole: string) =>
  memberRole
    .split(",")
    .map((r) => r.trim())
    .includes("owner");

export function toGrant(g: GrantRow, r: RoleRow): Grant {
  return {
    id: g.id,
    roleId: r.id,
    roleName: r.name,
    permissions: new Set(rolePermissions(r)),
    allBranches: g.allBranches,
    branchIds: new Set(g.branchIds),
    allNumbers: g.allNumbers,
    numberIds: new Set(g.numberIds),
  };
}

/** The person's access in a company, or null when they aren't a member. */
export async function loadAccessFor(db: Db, organizationId: string, userId: string): Promise<Access | null> {
  const [m] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  if (!m) return null;
  const rows = await db
    .select({ g: memberGrant, r: role })
    .from(memberGrant)
    .innerJoin(role, eq(role.id, memberGrant.roleId))
    .where(and(eq(memberGrant.organizationId, organizationId), eq(memberGrant.userId, userId)));
  return {
    orgId: organizationId,
    userId,
    owner: isOwnerRole(m.role),
    grants: rows.map(({ g, r }) => toGrant(g, r)),
  };
}

/** Everyone's access in a company (for "who can be assigned here"). */
export async function loadCompanyAccess(db: Db, organizationId: string): Promise<Access[]> {
  const members = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, organizationId));
  const rows = await db
    .select({ g: memberGrant, r: role })
    .from(memberGrant)
    .innerJoin(role, eq(role.id, memberGrant.roleId))
    .where(eq(memberGrant.organizationId, organizationId));
  return members.map((m) => ({
    orgId: organizationId,
    userId: m.userId,
    owner: isOwnerRole(m.role),
    grants: rows.filter(({ g }) => g.userId === m.userId).map(({ g, r }) => toGrant(g, r)),
  }));
}

/** Makes sure the company has the four built-in roles; returns them by key. */
export async function ensureBuiltInRoles(
  db: Db,
  organizationId: string,
): Promise<Record<BuiltInRole, RoleRow>> {
  const have = await db
    .select()
    .from(role)
    .where(and(eq(role.organizationId, organizationId), inArray(role.builtIn, [...builtInRoleKeys])));
  const missing = builtInRoleKeys.filter((k) => !have.some((r) => r.builtIn === k));
  if (missing.length) {
    await db
      .insert(role)
      .values(
        missing.map((k) => ({
          id: newId("role"),
          organizationId,
          name: builtInRoles[k].name,
          description: builtInRoles[k].description,
          builtIn: k,
        })),
      )
      .onConflictDoNothing();
    return ensureBuiltInRoles(db, organizationId);
  }
  return Object.fromEntries(have.map((r) => [r.builtIn, r])) as Record<BuiltInRole, RoleRow>;
}

/** Gives an accepted invitation's chosen access to the new member (once). */
export async function applyInvitationGrants(db: Db, invitationId: string, userId: string) {
  const rows = await db.select().from(invitationGrant).where(eq(invitationGrant.invitationId, invitationId));
  if (!rows.length) return;
  await db.insert(memberGrant).values(
    rows.map((g) => ({
      id: newId("memberGrant"),
      organizationId: g.organizationId,
      userId,
      roleId: g.roleId,
      allBranches: g.allBranches,
      branchIds: g.branchIds,
      allNumbers: g.allNumbers,
      numberIds: g.numberIds,
    })),
  );
  await db.delete(invitationGrant).where(eq(invitationGrant.invitationId, invitationId));
}
