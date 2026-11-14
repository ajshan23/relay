import { eq, schema } from "@relay/db";
import { type BroadcastRules, defaultBroadcastRules } from "@relay/db/schema";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";

/*
 * Business-wide settings.
 *   GET /api/settings/broadcasts   the broadcast rules (frequency cap, live chats)
 *   PUT /api/settings/broadcasts   change them (owners and admins)
 */

const rulesSchema = z.object({
  frequencyCap: z.number().int().min(1).max(50).nullable(),
  skipLiveChats: z.boolean(),
});

export function settingsRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));
  const s = schema.organizationSettings;

  async function rules(orgId: string): Promise<BroadcastRules> {
    const [row] = await ctx.db.select().from(s).where(eq(s.organizationId, orgId)).limit(1);
    return { ...defaultBroadcastRules, ...(row?.broadcast ?? {}) };
  }

  app.get("/broadcasts", async (c) => {
    const access = c.var.access;
    return c.json({ rules: await rules(access.orgId), canEdit: isOrgAdmin(access.orgRole) });
  });

  app.put("/broadcasts", async (c) => {
    const access = c.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c, 403, "forbidden", "Only owners and admins can change this.");
    const parsed = await parseBody(c, rulesSchema);
    if ("error" in parsed) return parsed.error;
    await ctx.db
      .insert(s)
      .values({ organizationId: access.orgId, broadcast: parsed.data })
      .onConflictDoUpdate({
        target: s.organizationId,
        set: { broadcast: parsed.data, updatedAt: new Date() },
      });
    return c.json({ rules: await rules(access.orgId), canEdit: true });
  });

  return app;
}
