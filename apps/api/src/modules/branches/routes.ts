import { newId } from "@relay/core";
import { and, count, eq, isNull, schema } from "@relay/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, branchAccess, fail, isOrgAdmin, requireOrg } from "./access";
import { getBranch, listBranches, listMembers, orgRoleOf } from "./queries";
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
const memberBody = z.object({ role: z.enum(schema.branchRoles) });

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
    if (!isOrgAdmin(access.orgRole)) return fail(c, 403, "forbidden");
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
    return c.json({ branch: await getBranch(ctx, access, id, "manager") }, 201);
  });

  app.patch("/:id", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    if (found.role !== "manager") return fail(c, 403, "forbidden");
    const body = await parseBody(c, updateBody);
    if (body.error) return body.error;
    await ctx.db
      .update(schema.branch)
      .set({ ...body.data, updatedAt: new Date() })
      .where(and(eq(schema.branch.id, found.branch.id), eq(schema.branch.organizationId, access.orgId)));
    return c.json({ branch: await getBranch(ctx, access, found.branch.id, found.role) });
  });

  app.delete("/:id", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    if (!isOrgAdmin(access.orgRole)) return fail(c, 403, "forbidden");
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
    return c.json({ members: await listMembers(ctx, access.orgId, found.branch.id) });
  });

  app.put("/:id/members/:userId", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    if (found.role !== "manager") return fail(c, 403, "forbidden");
    const body = await parseBody(c, memberBody);
    if (body.error) return body.error;
    const userId = c.req.param("userId");
    if (!(await orgRoleOf(ctx, access.orgId, userId))) return fail(c, 422, "not_in_organization");
    await ctx.db
      .insert(schema.branchMember)
      .values({
        id: newId("branchMember"),
        branchId: found.branch.id,
        organizationId: access.orgId,
        userId,
        role: body.data.role,
      })
      .onConflictDoUpdate({
        target: [schema.branchMember.branchId, schema.branchMember.userId],
        set: { role: body.data.role },
      });
    const members = await listMembers(ctx, access.orgId, found.branch.id);
    return c.json({ member: members.find((m) => m.userId === userId) });
  });

  app.delete("/:id/members/:userId", async (c) => {
    const access = c.var.access;
    const found = await branchAccess(ctx, access, c.req.param("id"));
    if (!found) return fail(c, 404, "not_found");
    if (found.role !== "manager") return fail(c, 403, "forbidden");
    await ctx.db
      .delete(schema.branchMember)
      .where(
        and(
          eq(schema.branchMember.branchId, found.branch.id),
          eq(schema.branchMember.organizationId, access.orgId),
          eq(schema.branchMember.userId, c.req.param("userId")),
        ),
      );
    return c.body(null, 204);
  });

  return app;
}
