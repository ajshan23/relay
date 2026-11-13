import { createHash } from "node:crypto";
import { newId } from "@relay/core";
import { and, asc, eq, inArray, schema, sql } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { compileFilter, FilterError } from "./filter";
import { activeFields, type BranchEnv, canEditContacts, listsById, requireBranch } from "./shared";

/*
 * Lists: who a broadcast goes to. Static lists are picked by hand (members added from the table);
 * smart lists are a saved filter and always current.
 *   GET    /api/contacts/lists         every list with how many contacts are in it
 *   POST   /api/contacts/lists         { name, kind, filter? }
 *   PATCH  /api/contacts/lists/:id     { name?, filter? }
 *   DELETE /api/contacts/lists/:id
 * Members are added and removed with POST /api/contacts/bulk (add_to_list, remove_from_list).
 */

const ruleSchema = z.object({
  field: z.string().max(80),
  op: z.string().max(20),
  value: z.unknown().optional(),
});
const filterSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  rules: z.array(ruleSchema).max(30),
});

const SMART_COUNT_TTL_S = 60;

export function contactListRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx));
  const l = schema.contactList;
  const c = schema.contact;

  /** Checks a smart list's filter compiles (known fields, no list-in-list loops). */
  async function checkFilter(orgId: string, branchId: string, filter: z.infer<typeof filterSchema>) {
    if (!filter.rules.length) throw new FilterError("A smart list needs at least one filter.");
    const fields = new Map((await activeFields(ctx.db, orgId)).map((f) => [f.key, f as never]));
    const lists = await listsById(ctx.db, orgId, branchId);
    // Compiling as if nested rejects smart lists that refer to other smart lists.
    compileFilter(filter as never, fields, lists, 1);
  }

  /**
   * How many contacts a smart list has. Counting runs its whole filter, so the answer is kept for a
   * minute: the sidebar asks often, and a count a few seconds old is fine.
   */
  async function smartCount(
    orgId: string,
    branchId: string,
    listId: string,
    filter: unknown,
    fields: Map<string, never>,
    lists: Awaited<ReturnType<typeof listsById>>,
  ) {
    const key = `relay:list-count:${listId}:${createHash("sha1").update(JSON.stringify(filter)).digest("hex")}`;
    const cached = await ctx.redis.get(key).catch(() => null);
    if (cached !== null) return Number(cached);
    let count = 0;
    try {
      const where = compileFilter(filter as never, fields, lists, 1);
      const [n] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(c)
        .where(and(eq(c.organizationId, orgId), eq(c.branchId, branchId), where));
      count = n?.n ?? 0;
    } catch {
      // A smart list whose field was archived counts as empty until it's fixed.
    }
    await ctx.redis.set(key, String(count), "EX", SMART_COUNT_TTL_S).catch(() => undefined);
    return count;
  }

  app.get("/", async (c2) => {
    const access = c2.var.access;
    const branchId = c2.var.branchId;
    const rows = await ctx.db
      .select()
      .from(l)
      .where(and(eq(l.organizationId, access.orgId), eq(l.branchId, branchId)))
      .orderBy(asc(l.name));
    const fields = new Map((await activeFields(ctx.db, access.orgId)).map((f) => [f.key, f as never]));
    const lists = await listsById(ctx.db, access.orgId, branchId);
    // Static lists: one grouped count for all of them.
    const staticIds = rows.filter((r) => r.kind === "static").map((r) => r.id);
    const members = staticIds.length
      ? await ctx.db
          .select({ listId: schema.contactListMember.listId, n: sql<number>`count(*)::int` })
          .from(schema.contactListMember)
          .where(inArray(schema.contactListMember.listId, staticIds))
          .groupBy(schema.contactListMember.listId)
      : [];
    const memberCount = new Map(members.map((m) => [m.listId, m.n]));
    const out = await Promise.all(
      rows.map(async (r) => {
        const count =
          r.kind === "static"
            ? (memberCount.get(r.id) ?? 0)
            : await smartCount(access.orgId, branchId, r.id, r.filter, fields, lists);
        return { id: r.id, name: r.name, kind: r.kind, filter: r.filter, count, createdAt: r.createdAt };
      }),
    );
    return c2.json({ lists: out });
  });

  app.post("/", async (c2) => {
    const access = c2.var.access;
    if (!(await canEditContacts(ctx.db, access, c2.var.branchId))) return fail(c2, 403, "forbidden");
    const parsed = await parseBody(
      c2,
      z.object({
        name: z.string().trim().min(1, "Give the list a name").max(80),
        kind: z.enum(["static", "smart"]),
        filter: filterSchema.optional(),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    try {
      if (b.kind === "smart")
        await checkFilter(access.orgId, c2.var.branchId, b.filter ?? { match: "all", rules: [] });
    } catch (err) {
      if (err instanceof FilterError) return fail(c2, 422, "invalid_filter", err.message);
      throw err;
    }
    const [row] = await ctx.db
      .insert(l)
      .values({
        id: newId("contactList"),
        organizationId: access.orgId,
        branchId: c2.var.branchId,
        name: b.name,
        kind: b.kind,
        filter: b.kind === "smart" ? (b.filter as never) : null,
        createdByUserId: access.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return fail(c2, 409, "duplicate", "There's already a list with that name.");
    return c2.json({ list: row }, 201);
  });

  app.patch("/:id", async (c2) => {
    const access = c2.var.access;
    if (!(await canEditContacts(ctx.db, access, c2.var.branchId))) return fail(c2, 403, "forbidden");
    const parsed = await parseBody(
      c2,
      z.object({ name: z.string().trim().min(1).max(80).optional(), filter: filterSchema.optional() }),
    );
    if ("error" in parsed) return parsed.error;
    const [list] = await ctx.db
      .select()
      .from(l)
      .where(
        and(
          eq(l.id, c2.req.param("id")),
          eq(l.organizationId, access.orgId),
          eq(l.branchId, c2.var.branchId),
        ),
      )
      .limit(1);
    if (!list) return fail(c2, 404, "not_found");
    const b = parsed.data;
    try {
      if (b.filter && list.kind === "smart") await checkFilter(access.orgId, c2.var.branchId, b.filter);
    } catch (err) {
      if (err instanceof FilterError) return fail(c2, 422, "invalid_filter", err.message);
      throw err;
    }
    const [row] = await ctx.db
      .update(l)
      .set({
        ...(b.name ? { name: b.name } : {}),
        ...(b.filter && list.kind === "smart" ? { filter: b.filter as never } : {}),
        updatedAt: new Date(),
      })
      .where(eq(l.id, list.id))
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === "23505") return [];
        throw err;
      });
    if (!row) return fail(c2, 409, "duplicate", "There's already a list with that name.");
    return c2.json({ list: row });
  });

  app.delete("/:id", async (c2) => {
    const access = c2.var.access;
    if (!(await canEditContacts(ctx.db, access, c2.var.branchId))) return fail(c2, 403, "forbidden");
    const res = await ctx.db
      .delete(l)
      .where(
        and(
          eq(l.id, c2.req.param("id")),
          eq(l.organizationId, access.orgId),
          eq(l.branchId, c2.var.branchId),
        ),
      )
      .returning({ id: l.id });
    if (!res.length) return fail(c2, 404, "not_found");
    return c2.body(null, 204);
  });

  return app;
}
