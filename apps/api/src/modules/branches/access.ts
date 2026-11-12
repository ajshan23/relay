import { and, eq, isNull, schema } from "@relay/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../../context";
import type { AuthEnv } from "../auth/session";

export type OrgRole = "owner" | "admin" | "member";
export type BranchRole = schema.BranchRole;
export type Access = { orgId: string; orgRole: OrgRole; userId: string };
export type AccessEnv = { Variables: AuthEnv["Variables"] & { access: Access } };

/** Sends the standard error body. */
export function fail(c: Context, status: ContentfulStatusCode, error: string, message?: string) {
  return c.json(message ? { error, message } : { error }, status);
}

/** Reads Better Auth's member role (which may be a comma list) as the strongest single role. */
export function toOrgRole(role: string): OrgRole {
  const roles = role.split(",").map((r) => r.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

/** True for organization roles that can reach and manage every branch. */
export function isOrgAdmin(role: OrgRole) {
  return role === "owner" || role === "admin";
}

/** The caller's organization and role for the session's active organization, or null if there is none. */
export async function loadAccess(ctx: AppContext, userId: string, orgId: string | null | undefined) {
  if (!orgId) return null;
  const [row] = await ctx.db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1);
  if (!row) return null;
  return { orgId, orgRole: toOrgRole(row.role), userId } satisfies Access;
}

/** Middleware: 409 no_active_organization unless the session has an organization the user belongs to. */
export function requireOrg(ctx: AppContext) {
  return createMiddleware<AccessEnv>(async (c, next) => {
    const access = await loadAccess(ctx, c.var.user.id, c.var.session.activeOrganizationId);
    if (!access) return fail(c, 409, "no_active_organization");
    c.set("access", access);
    await next();
  });
}

/** The active branch and the caller's effective role on it, or null when it does not exist here or is out of reach. */
export async function branchAccess(ctx: AppContext, access: Access, branchId: string) {
  const [found] = await ctx.db
    .select()
    .from(schema.branch)
    .where(
      and(
        eq(schema.branch.id, branchId),
        eq(schema.branch.organizationId, access.orgId),
        isNull(schema.branch.archivedAt),
      ),
    )
    .limit(1);
  if (!found) return null;
  if (isOrgAdmin(access.orgRole)) return { branch: found, role: "manager" as BranchRole };
  const [row] = await ctx.db
    .select({ role: schema.branchMember.role })
    .from(schema.branchMember)
    .where(
      and(
        eq(schema.branchMember.branchId, branchId),
        eq(schema.branchMember.organizationId, access.orgId),
        eq(schema.branchMember.userId, access.userId),
      ),
    )
    .limit(1);
  return row ? { branch: found, role: row.role } : null;
}
