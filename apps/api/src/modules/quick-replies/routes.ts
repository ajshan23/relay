import { newId } from "@relay/core";
import { and, asc, eq, isNull, or, schema } from "@relay/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { can, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { type BranchEnv, requireBranch } from "../contacts/shared";

/*
 * Quick replies: saved answers agents insert with "/" in the reply box. For the whole business
 * (branchId null) or one branch. Every call names the selected branch (?branch=).
 *   GET    /api/quick-replies          the business-wide ones and this branch's
 *   POST   /api/quick-replies          { shortcut, title, body, branchId: null | <this branch> }
 *   PATCH  /api/quick-replies/:id
 *   DELETE /api/quick-replies/:id
 * For now anyone who can reply in the branch may create, change and delete them.
 * TODO: tighten who can manage shared replies once roles are settled.
 */

const shortcut = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^\/+/, ""))
  .pipe(
    z
      .string()
      .min(1, "Give it a shortcut")
      .max(30)
      .regex(/^[\p{L}\p{N}_-]+$/u, "Shortcuts use letters, numbers, - and _ only (no spaces)"),
  );
const body = z.object({
  shortcut,
  title: z.string().trim().min(1, "Give it a title").max(80),
  body: z.string().trim().min(1, "Write the reply").max(4096),
  /** null: the whole business. Otherwise it must be the selected branch. */
  branchId: z.string().nullable(),
});

export function quickReplyRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx));
  const qr = schema.quickReply;
  /** Branch quick replies need the permission in the branch; whole-business ones on every branch. */
  const mayEdit = (c: { var: BranchEnv["Variables"] }, branchId: string | null) =>
    can(c.var.access, "quick_replies.manage", branchId ? { branchId } : {});
  async function existing(c: { var: BranchEnv["Variables"] }, id: string) {
    const [row] = await ctx.db
      .select({ branchId: qr.branchId })
      .from(qr)
      .where(and(eq(qr.id, id), visible(c.var.access.orgId, c.var.branchId)))
      .limit(1);
    return row ?? null;
  }
  const visible = (orgId: string, branchId: string) =>
    and(eq(qr.organizationId, orgId), or(isNull(qr.branchId), eq(qr.branchId, branchId)));

  app.get("/", async (c) => {
    const rows = await ctx.db
      .select({
        id: qr.id,
        shortcut: qr.shortcut,
        title: qr.title,
        body: qr.body,
        branchId: qr.branchId,
        updatedAt: qr.updatedAt,
        createdBy: schema.user.name,
      })
      .from(qr)
      .leftJoin(schema.user, eq(schema.user.id, qr.createdByUserId))
      .where(visible(c.var.access.orgId, c.var.branchId))
      .orderBy(asc(qr.shortcut));
    return c.json({ quickReplies: rows });
  });

  /** Saves, turning a duplicate shortcut into a clear message. */
  async function save(c: Context, run: () => Promise<Response>) {
    try {
      return await run();
    } catch (err) {
      // Postgres unique violation (drizzle keeps the driver's error as the cause).
      const e = err as { code?: string; cause?: { code?: string } };
      if (e.code === "23505" || e.cause?.code === "23505")
        return fail(c, 409, "shortcut_taken", "Another quick reply already uses that shortcut here.");
      throw err;
    }
  }

  app.post("/", async (c) => {
    const access = c.var.access;
    const parsed = await parseBody(c, body);
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    if (!mayEdit(c, b.branchId)) return fail(c, 403, "forbidden");
    if (b.branchId !== null && b.branchId !== c.var.branchId)
      return fail(c, 422, "invalid_input", "A quick reply can be for the whole business or this branch.");
    const out = await save(c, async () => {
      const [row] = await ctx.db
        .insert(qr)
        .values({
          id: newId("quickReply"),
          organizationId: access.orgId,
          createdByUserId: access.userId,
          ...b,
        })
        .returning();
      return c.json({ quickReply: row }, 201);
    });
    return out;
  });

  app.patch("/:id", async (c) => {
    const access = c.var.access;
    const was = await existing(c, c.req.param("id"));
    if (!was) return fail(c, 404, "not_found");
    if (!mayEdit(c, was.branchId) || !mayEdit(c, c.var.branchId)) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, body.partial());
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    if (b.branchId !== undefined && b.branchId !== null && b.branchId !== c.var.branchId)
      return fail(c, 422, "invalid_input", "A quick reply can be for the whole business or this branch.");
    const out = await save(c, async () => {
      const [row] = await ctx.db
        .update(qr)
        .set({ ...b, updatedAt: new Date() })
        .where(and(eq(qr.id, c.req.param("id")), visible(access.orgId, c.var.branchId)))
        .returning();
      if (!row) return fail(c, 404, "not_found");
      return c.json({ quickReply: row });
    });
    return out;
  });

  app.delete("/:id", async (c) => {
    const access = c.var.access;
    const was = await existing(c, c.req.param("id"));
    if (!was) return fail(c, 404, "not_found");
    if (!mayEdit(c, was.branchId) || !mayEdit(c, c.var.branchId)) return fail(c, 403, "forbidden");
    const gone = await ctx.db
      .delete(qr)
      .where(and(eq(qr.id, c.req.param("id")), visible(access.orgId, c.var.branchId)))
      .returning({ id: qr.id });
    if (!gone.length) return fail(c, 404, "not_found");
    return c.body(null, 204);
  });

  return app;
}
