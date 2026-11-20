import { newId } from "@relay/core";
import { and, count, ensureBuiltInRoles, eq, isNull, schema } from "@relay/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { grantInput, grantsOf, saveGrants } from "../team/grants";
import { type AccessEnv, branchAccess, can, fail, requireOrg } from "./access";
import { getBranch, isMember, listBranches, listMembers } from "./queries";
import { uniqueSlug } from "./slug";

function isTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const name = z.string().trim().min(1, "name is required").max(80, "name is too long");
const timezone = z.string().refine(isTimezone, "unknown timezone");
const createBody = z.object({ name, timezone: timezone.optional() });
const updateBody = z.object({ name: name.optional(), timezone: timezone.optional() });
/** Someone's access in one branch: a role (or a built-in one by key), on all or some of its numbers. */
const memberBody = z.object({
  roleId: z.string().optional(),
  role: z.enum(["admin", "manager", "agent", "viewer"]).optional(),
  allNumbers: z.boolean().default(true),
  numberIds: z.array(z.string()).max(500).default([]),
});

/** Parses the JSON body with the schema; returns the data or a 422 response. */
export async function parseBody<T extends z.ZodType>(c: Context, body: T) {
  const raw = await c.req.json().catch(() => undefined);
  const parsed = body.safeParse(raw);
  if (parsed.success) return { data: parsed.data as z.infer<T> };
  const message = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message);
  return { error: fail(c, 422, "invalid_input", message.join("; ")) };
}

/** Branches of the active organization and who works in each. */
export function branchRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  app.get("/", async (c) => c.json({ branches: await listBranches(ctx, c.var.access) }));

  app.post("/", async (c) => {
    const access = c.var.access;
    if (!can(access, "branches.create")) return fail(c, 403, "forbidden");
    const body = await parseBody(c, createBody);
    if (body.error) return body.error;
    const id = newId("branch");
    await ctx.db.insert(schema.branch).values({
      id,
      organizationId: access.orgId,
      name: body.data.name,
      slug: await uniqueSlug(ctx, access.orgId, body.data.name),
      timezone: body.data.timezone ?? "UTC",
    });
    return c.json({ branch: await getBranch(ctx, access, id) }, 201);
  });

  app.patch("/:id", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    if (!can(access, "branches.edit", { branchId: found.branch.id })) return fail(c, 403, "forbidden");
    const body = await parseBody(c, updateBody);
    if (body.error) return body.error;
    await ctx.db
      .update(schema.branch)
      .set({ ...body.data, updatedAt: new Date() })
      .where(and(eq(schema.branch.id, found.branch.id), eq(schema.branch.organizationId, access.orgId)));
    return c.json({ branch: await getBranch(ctx, access, found.branch.id) });
  });

  app.delete("/:id", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    if (!can(access, "branches.delete")) return fail(c, 403, "forbidden");
    const [active] = await ctx.db
      .select({ n: count() })
      .from(schema.branch)
      .where(and(eq(schema.branch.organizationId, access.orgId), isNull(schema.branch.archivedAt)));
    if ((active?.n ?? 0) <= 1)
      return fail(c, 409, "last_branch", "An organization needs at least one branch.");
    await ctx.db
      .update(schema.branch)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.branch.id, found.branch.id), eq(schema.branch.organizationId, access.orgId)));
    return c.body(null, 204);
  });

  app.get("/:id/members", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    const branchId = found.branch.id;
    const canManage = can(access, "branches.people", { branchId }) || can(access, "team.edit_access");
    const [roles, numbers] = canManage
      ? await Promise.all([
          ensureBuiltInRoles(ctx.db, access.orgId).then(() =>
            ctx.db
              .select({ id: schema.role.id, name: schema.role.name, builtIn: schema.role.builtIn })
              .from(schema.role)
              .where(eq(schema.role.organizationId, access.orgId))
              .orderBy(schema.role.createdAt),
          ),
          ctx.db
            .select({
              id: schema.channelAccount.id,
              name: schema.channelAccount.displayName,
              phone: schema.channelAccount.displayPhone,
            })
            .from(schema.channelAccount)
            .where(
              and(
                eq(schema.channelAccount.branchId, branchId),
                eq(schema.channelAccount.organizationId, access.orgId),
              ),
            ),
        ])
      : [[], []];
    return c.json({ members: await listMembers(ctx, access.orgId, branchId), roles, numbers, canManage });
  });

  // Give someone a role in this branch (replacing their access made just for this branch).
  app.put("/:id/members/:userId", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    const branchId = found.branch.id;
    if (!can(access, "branches.people", { branchId }) && !can(access, "team.edit_access"))
      return fail(c, 403, "forbidden");
    const body = await parseBody(c, memberBody);
    if (body.error) return body.error;
    const userId = c.req.param("userId");
    if (!(await isMember(ctx, access.orgId, userId))) return fail(c, 422, "not_in_organization");
    if (userId === access.userId)
      return fail(c, 409, "own_access", "Ask someone else to change your access.");
    let roleId = body.data.roleId;
    if (!roleId && body.data.role)
      roleId = (await ensureBuiltInRoles(ctx.db, access.orgId))[body.data.role].id;
    if (!roleId) return fail(c, 422, "invalid_input", "Pick a role.");
    const grant = grantInput.parse({
      roleId,
      allBranches: false,
      branchIds: [branchId],
      allNumbers: body.data.allNumbers,
      numberIds: body.data.numberIds,
    });
    const mine = (await grantsOf(ctx, access.orgId, userId)).filter(
      (g) => !g.allBranches && g.branchIds.length === 1 && g.branchIds[0] === branchId,
    );
    const saved = await saveGrants(ctx, access, userId, mine, [grant]);
    if (!saved.ok) return fail(c, saved.status, saved.code, saved.message);
    const members = await listMembers(ctx, access.orgId, branchId);
    return c.json({ member: members.find((m) => m.userId === userId) });
  });

  // Take someone out of this branch: grants just for it go; grants for several branches lose it.
  app.delete("/:id/members/:userId", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    const branchId = found.branch.id;
    if (!can(access, "branches.people", { branchId }) && !can(access, "team.edit_access"))
      return fail(c, 403, "forbidden");
    const userId = c.req.param("userId");
    if (userId === access.userId)
      return fail(c, 409, "own_access", "Ask someone else to change your access.");
    const here = (await grantsOf(ctx, access.orgId, userId)).filter(
      (g) => !g.allBranches && g.branchIds.includes(branchId),
    );
    const branchNumbers = new Set(
      (
        await ctx.db
          .select({ id: schema.channelAccount.id })
          .from(schema.channelAccount)
          .where(eq(schema.channelAccount.branchId, branchId))
      ).map((n) => n.id),
    );
    const keep = here
      .filter((g) => g.branchIds.length > 1)
      .map((g) => ({
        roleId: g.roleId,
        allBranches: false,
        branchIds: g.branchIds.filter((b) => b !== branchId),
        allNumbers: g.allNumbers,
        numberIds: g.numberIds.filter((n) => !branchNumbers.has(n)),
      }))
      // A grant limited to numbers of this branch only has nothing left.
      .filter((g) => g.allNumbers || g.numberIds.length > 0);
    const saved = await saveGrants(ctx, access, userId, here, keep);
    if (!saved.ok) return fail(c, saved.status, saved.code, saved.message);
    return c.body(null, 204);
  });

  return app;
}
