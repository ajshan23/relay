import { decryptSecret, encryptSecret, newId } from "@relay/core";
import { GoogleError, refreshGoogleToken } from "@relay/core/google-calendar";
import { getGoogleTask, insertGoogleTask } from "@relay/core/google-tasks";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { CalendarDeps } from "./booking-calendar";
import type { createDb } from "./client";
import { agentTask, taskConnection } from "./schema";

/*
 * A branch's Google Tasks, shared by the API and the worker: the token kept fresh, follow-ups added
 * once (a row is written first, so a retried step finds it instead of adding a second task), and the
 * chat's open follow-ups, so the agent doesn't add the same one twice.
 */

type Db = ReturnType<typeof createDb>["db"];
/** The same Google client and secret key as the booking calendar. */
export type TaskDeps = CalendarDeps;
export type TaskConnectionRow = typeof taskConnection.$inferSelect;

export async function taskConnectionOf(db: Db, organizationId: string, branchId: string) {
  const [c] = await db
    .select()
    .from(taskConnection)
    .where(and(eq(taskConnection.organizationId, organizationId), eq(taskConnection.branchId, branchId)))
    .limit(1);
  return c ?? null;
}

/** A working access token (refreshed and saved when close to expiring), or null when Google refused. */
export async function tasksAccessTokenFor(
  db: Db,
  deps: TaskDeps,
  conn: TaskConnectionRow,
): Promise<string | null> {
  if (conn.status === "needs_reconnect") return null;
  const soon = Date.now() + 2 * 60_000;
  if (conn.accessToken && conn.accessExpiresAt && conn.accessExpiresAt.getTime() > soon)
    return decryptSecret(conn.accessToken, deps.secretKey);
  try {
    const fresh = await refreshGoogleToken(deps.google, decryptSecret(conn.refreshToken, deps.secretKey));
    await db
      .update(taskConnection)
      .set({
        accessToken: encryptSecret(fresh.accessToken, deps.secretKey),
        accessExpiresAt: fresh.expiresAt,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(taskConnection.id, conn.id));
    return fresh.accessToken;
  } catch (err) {
    if (err instanceof GoogleError && (err.kind === "invalid_grant" || err.kind === "auth")) {
      await needsReconnect(db, conn.id);
      return null;
    }
    throw err;
  }
}

async function needsReconnect(db: Db, id: string) {
  await db
    .update(taskConnection)
    .set({
      status: "needs_reconnect",
      lastError: "Google no longer lets Relay add tasks. Connect Google Tasks again.",
      updatedAt: new Date(),
    })
    .where(eq(taskConnection.id, id));
}

export type FollowUp = {
  organizationId: string;
  branchId: string;
  agentId: string | null;
  conversationId: string | null;
  title: string;
  notes: string;
  dueDate: string | null;
  source: "agent" | "handoff";
};

export type FollowUpResult =
  | { ok: true; taskId: string; reused: boolean }
  | { ok: false; reason: "not_connected" | "needs_reconnect" | "failed"; message: string };

/**
 * Adds a follow-up to the branch's chosen list. `key` makes it happen once: the same key (a recorded
 * step) finds the row it wrote before rather than adding another task.
 */
export async function addFollowUpTask(
  db: Db,
  deps: TaskDeps,
  key: string,
  task: FollowUp,
): Promise<FollowUpResult> {
  const conn = await taskConnectionOf(db, task.organizationId, task.branchId);
  if (!conn?.listId) return { ok: false, reason: "not_connected", message: "Google Tasks isn't connected." };
  const id = `${newId("agentTask").split("_")[0]}_${key}`.slice(0, 200);
  const [existing] = await db.select().from(agentTask).where(eq(agentTask.id, id)).limit(1);
  if (existing?.externalTaskId) return { ok: true, taskId: existing.id, reused: true };
  if (!existing)
    await db.insert(agentTask).values({
      id,
      organizationId: task.organizationId,
      branchId: task.branchId,
      agentId: task.agentId,
      conversationId: task.conversationId,
      title: task.title,
      notes: task.notes,
      dueDate: task.dueDate,
      source: task.source,
      listId: conn.listId,
    });
  const fail = async (reason: "needs_reconnect" | "failed", message: string): Promise<FollowUpResult> => {
    await db
      .update(agentTask)
      .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(agentTask.id, id));
    return { ok: false, reason, message };
  };
  const token = await tasksAccessTokenFor(db, deps, conn);
  if (!token) return fail("needs_reconnect", "Google Tasks needs connecting again.");
  try {
    const made = await insertGoogleTask(deps.google, token, conn.listId, {
      title: task.title,
      notes: task.notes,
      due: task.dueDate,
    });
    await db
      .update(agentTask)
      .set({ externalTaskId: made.id, status: "open", error: null, updatedAt: new Date() })
      .where(eq(agentTask.id, id));
    return { ok: true, taskId: id, reused: false };
  } catch (err) {
    if (err instanceof GoogleError && err.kind === "auth") {
      await needsReconnect(db, conn.id);
      return fail("needs_reconnect", "Google Tasks needs connecting again.");
    }
    if (err instanceof GoogleError && err.kind === "not_found")
      return fail("failed", "The chosen Google Tasks list no longer exists. Choose another one.");
    return fail("failed", (err as Error).message);
  }
}

/**
 * The chat's follow-ups from the last 30 days that the team hasn't ticked off yet. Ones still marked
 * open are checked with Google (at most 5), so a task done there drops out here.
 */
export async function openFollowUps(
  db: Db,
  deps: TaskDeps | null,
  organizationId: string,
  branchId: string,
  conversationId: string,
) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select()
    .from(agentTask)
    .where(
      and(
        eq(agentTask.organizationId, organizationId),
        eq(agentTask.conversationId, conversationId),
        inArray(agentTask.status, ["open", "sending"]),
        gt(agentTask.createdAt, since),
      ),
    )
    .orderBy(desc(agentTask.createdAt))
    .limit(5);
  if (!rows.length || !deps) return rows;
  const conn = await taskConnectionOf(db, organizationId, branchId);
  const token = conn ? await tasksAccessTokenFor(db, deps, conn).catch(() => null) : null;
  if (!token) return rows;
  const still = [];
  for (const r of rows) {
    if (r.status !== "open" || !r.externalTaskId || !r.listId) {
      still.push(r);
      continue;
    }
    const now = await getGoogleTask(deps.google, token, r.listId, r.externalTaskId).catch(() => undefined);
    if (now === undefined || now?.status === "needsAction") still.push(r);
    else
      await db.update(agentTask).set({ status: "done", updatedAt: new Date() }).where(eq(agentTask.id, r.id));
  }
  return still;
}
