import { eq, getStorageUsage, schema, sql, storageWarnAt } from "@relay/db";
import { type BroadcastRules, defaultBroadcastRules } from "@relay/db/schema";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, can, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";

/*
 * Business-wide settings.
 *   GET /api/settings/broadcasts   the broadcast rules (frequency cap, live chats)
 *   PUT /api/settings/broadcasts   change them (owners and admins)
 *   GET /api/settings/storage      file storage used and the limit; owners and admins also get the
 *                                  largest files, so they know what to delete
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
    return c.json({ rules: await rules(access.orgId), canEdit: can(access, "settings.manage") });
  });

  app.put("/broadcasts", async (c) => {
    const access = c.var.access;
    if (!can(access, "settings.manage"))
      return fail(c, 403, "forbidden", "You don't have access to change this.");
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

  app.get("/storage", async (c) => {
    const access = c.var.access;
    const usage = await getStorageUsage(ctx.db, access.orgId);
    const admin = can(access, "usage.view");
    let largest: {
      id: string;
      name: string | null;
      usedIn: string;
      mimeType: string | null;
      sizeBytes: number;
      createdAt: string;
    }[] = [];
    if (admin) {
      // Where each file is used, for a name people recognise.
      const rows = await ctx.db.execute(sql`
        select f.id, f.mime_type, f.size_bytes, f.created_at,
          coalesce(
            (select k.file_name from knowledge_source k where k.file_id = f.id limit 1),
            (select a.file_name from attachment a where a.file_id = f.id and a.file_name is not null limit 1)
          ) as name,
          case
            when exists (select 1 from knowledge_source k where k.file_id = f.id) then 'knowledge'
            when exists (select 1 from ai_agent g where g.avatar_file_id = f.id) then 'agent'
            when exists (select 1 from attachment a join message m on m.id = a.message_id
                         where a.file_id = f.id and m.direction = 'inbound') then 'from_customers'
            when exists (select 1 from attachment a where a.file_id = f.id) then 'sent'
            else 'unused'
          end as used_in
        from stored_file f
        where f.organization_id = ${access.orgId}
        order by f.size_bytes desc
        limit 10`);
      largest = (Array.isArray(rows) ? rows : []).map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: String(row.id),
          name: (row.name as string | null) ?? null,
          usedIn: String(row.used_in),
          mimeType: (row.mime_type as string | null) ?? null,
          sizeBytes: Number(row.size_bytes),
          createdAt: new Date(row.created_at as string).toISOString(),
        };
      });
    }
    return c.json({ ...usage, warnAt: storageWarnAt, largest, canSeeFiles: admin });
  });

  return app;
}
