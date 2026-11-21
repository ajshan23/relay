import { decryptSecret, encryptSecret, newId } from "@relay/core";
import { exchangeGoogleCode, googleAuthUrl, revokeGoogleToken } from "@relay/core/google-calendar";
import { createTaskList, followUpListName, googleTasksScopes, listTaskLists } from "@relay/core/google-tasks";
import {
  and,
  calendarDepsFrom,
  desc,
  eq,
  ne,
  schema,
  taskConnectionOf,
  tasksAccessTokenFor,
} from "@relay/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { can, fail } from "../branches/access";
import { parseBody } from "../branches/routes";
import type { BranchEnv } from "../contacts/shared";

/*
 * Google Tasks, where the agent adds follow-ups for the team (one Google account per branch):
 *   GET    /api/agents/google-tasks          the connection (no tokens), recent follow-ups, set up?
 *   POST   /api/agents/google-tasks/connect  (agent managers) Google's consent address to open
 *   PUT    /api/agents/google-tasks          (agent managers) { listId? | newList?, enabled?, onHandoff? }
 *   POST   /api/agents/google-tasks/lists    (agent managers) read the lists again
 *   DELETE /api/agents/google-tasks          (agent managers) disconnect
 * Google sends the manager back to the booking calendar's callback (one redirect address for both);
 * the encrypted state says it was Tasks (see bookings/google.ts).
 */

const STATE_MS = 10 * 60_000;
const T = schema.taskConnection;
const AT = schema.agentTask;

export type GoogleState = { o: string; b: string; u: string; e: number; n: string; p?: "tasks" };

export const shownTaskConnection = (conn: typeof T.$inferSelect | null) =>
  conn
    ? {
        accountEmail: conn.accountEmail,
        listId: conn.listId,
        listName: conn.listName,
        lists: conn.lists,
        enabled: conn.enabled,
        onHandoff: conn.onHandoff,
        status: conn.status,
        lastError: conn.lastError,
        updatedAt: conn.updatedAt,
      }
    : null;

/**
 * Revoking a Google token ends Relay's whole access for that account, calendar included, so it's only
 * revoked when no other branch's calendar or tasks connection uses the same account.
 */
export async function googleAccountInUse(
  ctx: AppContext,
  email: string | null,
  except: { calendarId?: string; taskId?: string },
): Promise<boolean> {
  if (!email) return false;
  const C = schema.calendarConnection;
  const [cal] = await ctx.db
    .select({ id: C.id })
    .from(C)
    .where(and(eq(C.accountEmail, email), ...(except.calendarId ? [ne(C.id, except.calendarId)] : [])))
    .limit(1);
  if (cal) return true;
  const [task] = await ctx.db
    .select({ id: T.id })
    .from(T)
    .where(and(eq(T.accountEmail, email), ...(except.taskId ? [ne(T.id, except.taskId)] : [])))
    .limit(1);
  return !!task;
}

export function registerTaskRoutes(
  app: Hono<BranchEnv>,
  ctx: AppContext,
  opts: { canManage: (c: Context<BranchEnv>) => Promise<boolean> },
) {
  const deps = calendarDepsFrom(ctx.config);
  const view = async (c: Context<BranchEnv>) => {
    const conn = await taskConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId);
    const recent = await ctx.db
      .select({
        id: AT.id,
        title: AT.title,
        dueDate: AT.dueDate,
        status: AT.status,
        source: AT.source,
        conversationId: AT.conversationId,
        error: AT.error,
        createdAt: AT.createdAt,
      })
      .from(AT)
      .where(and(eq(AT.organizationId, c.var.access.orgId), eq(AT.branchId, c.var.branchId)))
      .orderBy(desc(AT.createdAt))
      .limit(10);
    return {
      configured: !!deps,
      connection: shownTaskConnection(conn),
      recent,
      canManage: await opts.canManage(c),
    };
  };

  app.get("/google-tasks", async (c) => c.json(await view(c)));

  app.post("/google-tasks/connect", async (c) => {
    if (!(await opts.canManage(c))) return fail(c, 403, "forbidden");
    if (!deps) return fail(c, 422, "not_configured", "Google isn't set up on this server yet.");
    const state: GoogleState = {
      o: c.var.access.orgId,
      b: c.var.branchId,
      u: c.var.access.userId,
      e: Date.now() + STATE_MS,
      n: newId("taskConnection"),
      p: "tasks",
    };
    return c.json({
      url: googleAuthUrl(deps.google, encryptSecret(state, deps.secretKey), googleTasksScopes),
    });
  });

  const settings = z
    .object({
      listId: z.string().min(1).max(500).optional(),
      /** Make Relay's own "WhatsApp follow-ups" list and use it. */
      newList: z.literal(true).optional(),
      enabled: z.boolean().optional(),
      onHandoff: z.boolean().optional(),
    })
    .strict();

  app.put("/google-tasks", async (c) => {
    if (!(await opts.canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, settings);
    if ("error" in parsed) return parsed.error;
    const conn = await taskConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId);
    if (!conn) return fail(c, 404, "not_found", "Connect Google Tasks first.");
    const set: Partial<typeof T.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.enabled !== undefined) set.enabled = parsed.data.enabled;
    if (parsed.data.onHandoff !== undefined) set.onHandoff = parsed.data.onHandoff;
    if (parsed.data.listId) {
      const list = conn.lists.find((l) => l.id === parsed.data.listId);
      if (!list) return fail(c, 422, "invalid_input", "That isn't one of your task lists.");
      set.listId = list.id;
      set.listName = list.name;
    } else if (parsed.data.newList) {
      if (!deps) return fail(c, 422, "not_configured", "Google isn't set up on this server yet.");
      const token = await tasksAccessTokenFor(ctx.db, deps, conn);
      if (!token) return fail(c, 409, "needs_reconnect", "Google Tasks needs connecting again.");
      const made = await createTaskList(deps.google, token, followUpListName);
      set.listId = made.id;
      set.listName = made.name;
      set.lists = [...conn.lists.filter((l) => l.id !== made.id), made];
    }
    await ctx.db.update(T).set(set).where(eq(T.id, conn.id));
    return c.json(await view(c));
  });

  app.post("/google-tasks/lists", async (c) => {
    if (!(await opts.canManage(c))) return fail(c, 403, "forbidden");
    if (!deps) return fail(c, 422, "not_configured", "Google isn't set up on this server yet.");
    const conn = await taskConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId);
    if (!conn) return fail(c, 404, "not_found", "Connect Google Tasks first.");
    const token = await tasksAccessTokenFor(ctx.db, deps, conn);
    if (!token) return fail(c, 409, "needs_reconnect", "Google Tasks needs connecting again.");
    const lists = await listTaskLists(deps.google, token);
    const chosen = lists.find((l) => l.id === conn.listId);
    await ctx.db
      .update(T)
      .set({
        lists,
        // The chosen list was deleted in Google: nothing is chosen until the manager picks one.
        ...(conn.listId && !chosen ? { listId: null, listName: null } : {}),
        ...(chosen ? { listName: chosen.name } : {}),
        updatedAt: new Date(),
      })
      .where(eq(T.id, conn.id));
    return c.json(await view(c));
  });

  app.delete("/google-tasks", async (c) => {
    if (!(await opts.canManage(c))) return fail(c, 403, "forbidden");
    const conn = await taskConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId);
    if (!conn) return c.json({ ok: true });
    if (deps && !(await googleAccountInUse(ctx, conn.accountEmail, { taskId: conn.id })))
      await revokeGoogleToken(deps.google, decryptSecret(conn.refreshToken, deps.secretKey));
    await ctx.db.delete(T).where(eq(T.id, conn.id));
    return c.json({ ok: true });
  });
}

/**
 * Back from Google's consent screen for Tasks (called by the shared callback). Uses the list the
 * business already made for this, else makes "WhatsApp follow-ups". Returns the outcome to show.
 */
export async function finishTasksConnect(
  ctx: AppContext,
  state: GoogleState,
  code: string,
  access: Parameters<typeof can>[0],
): Promise<string> {
  const deps = calendarDepsFrom(ctx.config);
  if (!deps) return "not_configured";
  if (!can(access, "agent.manage", { branchId: state.b })) return "forbidden";
  const tokens = await exchangeGoogleCode(deps.google, code);
  if (!tokens.refreshToken) return "no_offline_access";
  // Google's consent screen lets people untick a permission.
  if (!tokens.scope.split(" ").includes("https://www.googleapis.com/auth/tasks"))
    return "no_tasks_permission";
  let lists = await listTaskLists(deps.google, tokens.accessToken);
  let list = lists.find((l) => l.name === followUpListName);
  if (!list) {
    list = await createTaskList(deps.google, tokens.accessToken, followUpListName);
    lists = [...lists, list];
  }
  const values = {
    organizationId: state.o,
    branchId: state.b,
    provider: "google" as const,
    accountEmail: tokens.email,
    refreshToken: encryptSecret(tokens.refreshToken, deps.secretKey),
    accessToken: encryptSecret(tokens.accessToken, deps.secretKey),
    accessExpiresAt: tokens.expiresAt,
    lists,
    listId: list.id,
    listName: list.name,
    status: "active" as const,
    lastError: null,
    connectedByUserId: access.userId,
    updatedAt: new Date(),
  };
  await ctx.db
    .insert(T)
    .values({ id: newId("taskConnection"), ...values })
    .onConflictDoUpdate({ target: T.branchId, set: values });
  return "connected";
}
