import { eq, schema } from "@relay/db";
import { Hono } from "hono";
import type { AppContext } from "../../context";
import { type AuthEnv, requireSession } from "../auth/session";
import { loadAccess } from "../branches/access";
import { listBranches } from "../branches/queries";

/** GET /api/me: the signed-in user, their active organization and role, and the branches they can reach. */
export function meRoutes(ctx: AppContext) {
  const app = new Hono<AuthEnv>();
  app.use(requireSession);

  app.get("/", async (c) => {
    const { id, name, email, image } = c.var.user;
    const user = { id, name, email, image: image ?? null };
    const access = await loadAccess(ctx, id, c.var.session.activeOrganizationId);
    if (!access) return c.json({ user, organization: null, orgRole: null, branches: [] });

    const [org] = await ctx.db
      .select({ id: schema.organization.id, name: schema.organization.name, slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, access.orgId));
    const branches = (await listBranches(ctx, access)).map(({ id, name, slug, timezone, role }) => ({
      id,
      name,
      slug,
      timezone,
      role,
    }));
    return c.json({ user, organization: org ?? null, orgRole: access.orgRole, branches });
  });

  return app;
}
