import { type Access, can, type Permission, type Place, reachableBranchIds } from "@relay/core/permissions";
import { and, eq, isNull, loadAccessFor, schema } from "@relay/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "../../context";
import type { AuthEnv } from "../auth/session";

/*
 * Every request's access: the person's grants in the active company (see @relay/core/permissions).
 * Routes ask `can(access, permission, { branchId, channelId })`; nothing else decides who may do what.
 */

export type { Access, Permission, Place };
export { can };
export type AccessEnv = { Variables: AuthEnv["Variables"] & { access: Access } };

/** Sends the standard error body. */
export function fail(c: Context, status: ContentfulStatusCode, error: string, message?: string) {
  return c.json(message ? { error, message } : { error }, status);
}

/** 403 unless the caller may do `perm` here. Returns the response to send, or null to carry on. */
export function deny(c: Context, access: Access, perm: Permission, place: Place = {}, message?: string) {
  return can(access, perm, place)
    ? null
    : fail(c, 403, "forbidden", message ?? "You don't have access to do that.");
}

/** The caller's access for the session's active company, or null if they aren't in it. */
export async function loadAccess(ctx: AppContext, userId: string, orgId: string | null | undefined) {
  if (!orgId) return null;
  return loadAccessFor(ctx.db, orgId, userId);
}

/** Middleware: 409 no_active_organization unless the session has a company the user belongs to. */
export function requireOrg(ctx: AppContext) {
  return createMiddleware<AccessEnv>(async (c, next) => {
    const access = await loadAccess(ctx, c.var.user.id, c.var.session.activeOrganizationId);
    if (!access) return fail(c, 409, "no_active_organization");
    c.set("access", access);
    await next();
  });
}

/** Can any of their grants reach this branch? */
export function reaches(access: Access, branchId: string) {
  const r = reachableBranchIds(access);
  return r === "all" || r.has(branchId);
}

/** The branch (not archived, in this company) when the caller can reach it, else null. */
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
  if (!found || !reaches(access, branchId)) return null;
  return { branch: found };
}
