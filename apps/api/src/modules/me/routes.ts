import { allPermissions, can, companyPermissions } from "@relay/core/permissions";
import { eq, schema } from "@relay/db";
import { Hono } from "hono";
import type { AppContext } from "../../context";
import { type AuthEnv, requireSession } from "../auth/session";
import { loadAccess } from "../branches/access";
import { listBranches } from "../branches/queries";

/**
 * GET /api/me: the signed-in user, their active company, what they may do across the company, and
 * the branches they can reach with what they may do in each (see @relay/core/permissions).
 */
export function meRoutes(ctx: AppContext) {
  const app = new Hono<AuthEnv>();
  app.use(requireSession);

  app.get("/", async (c) => {
    const { id, name, email, image } = c.var.user;
    const user = { id, name, email, image: image ?? null };
    const access = await loadAccess(ctx, id, c.var.session.activeOrganizationId);
    if (!access)
      return c.json({ user, organization: null, orgRole: null, owner: false, permissions: [], branches: [] });

    const [org] = await ctx.db
      .select({ id: schema.organization.id, name: schema.organization.name, slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, access.orgId));
    const branches = (await listBranches(ctx, access)).map(
      ({ id, name, slug, timezone, logoUrl, role, permissions }) => ({
        id,
        name,
        slug,
        timezone,
        logoUrl,
        role,
        permissions,
      }),
    );
    // Company-wide permissions (numbers, team, roles, settings...).
    const permissions = allPermissions.filter((p) => companyPermissions.has(p) && can(access, p));
    return c.json({
      user,
      organization: org ?? null,
      // Kept for older screens: "owner", "admin" (can change anyone's access) or "member".
      orgRole: access.owner ? "owner" : can(access, "team.edit_access") ? "admin" : "member",
      owner: access.owner,
      permissions,
      branches,
    });
  });

  return app;
}
