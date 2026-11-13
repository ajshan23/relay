import { type InboxEvent, inboxChannel } from "@relay/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, fail, requireOrg } from "../branches/access";
import { reachableBranches } from "../conversations/access";
import { createEventHub } from "./hub";

/*
 * GET /api/events: live updates for the open inbox, as Server-Sent Events.
 * The worker and the API publish small hints to Redis (see @relay/core inbox.ts); this forwards the
 * ones about conversations the caller can reach. The browser refetches what it shows, so a missed
 * event only delays a refresh, and on reconnect the browser refetches everything.
 *
 * `?branch=` limits the stream to the branch the browser shows (the app always passes it), so a busy
 * branch never makes the other branches' inboxes refetch.
 *
 * Served by its own process (src/realtime.ts), not the main API: thousands of open tabs never compete
 * with ordinary requests, and deploying the API doesn't drop everyone's live connection.
 */

const HEARTBEAT_MS = 25_000;
const BRANCHES_REFRESH_MS = 60_000;

/**
 * Which branches each person can reach, shared by all their open tabs on this process and refreshed
 * once a minute: one query per person, not one per tab.
 */
function createAccessCache(ctx: AppContext) {
  const entries = new Map<string, { at: number; branches: Promise<string[] | null> }>();
  // Drop people who closed their tabs a while ago.
  setInterval(() => {
    const cutoff = Date.now() - BRANCHES_REFRESH_MS * 5;
    for (const [key, e] of entries) if (e.at < cutoff) entries.delete(key);
  }, BRANCHES_REFRESH_MS * 5).unref();
  return {
    branches(access: AccessEnv["Variables"]["access"]) {
      const key = `${access.orgId}:${access.userId}`;
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < BRANCHES_REFRESH_MS) return hit.branches;
      const branches = reachableBranches(ctx, access);
      // A failed lookup isn't kept, so the next event asks again.
      branches.catch(() => entries.delete(key));
      entries.set(key, { at: Date.now(), branches });
      return branches;
    },
    size: () => entries.size,
  };
}

export function eventRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));
  const hub = createEventHub(ctx.config.REDIS_URL);
  const reach = createAccessCache(ctx);
  // Proxies (the web app's /api rewrite in development, CDNs later) must pass events through as they
  // come: no compression (no-transform), no buffering. Set after the handler; streamSSE sets its own.
  app.use(async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-cache, no-transform");
    c.res.headers.set("X-Accel-Buffering", "no");
  });

  app.get("/", async (c) => {
    const access = c.var.access;
    const only = c.req.query("branch") || null;
    const atStart = await reach.branches(access);
    if (only && atStart !== null && !atStart.includes(only)) return fail(c, 403, "forbidden");
    return streamSSE(c, async (stream) => {
      let closed = false;
      let queue = Promise.resolve();

      const allowed = async (event: InboxEvent) => {
        if (event.type === "template.updated") return true; // templates are organization-wide
        if (event.type === "conversation.read" && event.userId !== access.userId) return false;
        if (only && event.branchId !== only) return false;
        const branches = await reach.branches(access);
        if (branches === null) return true;
        return !!event.branchId && branches.includes(event.branchId);
      };

      // Writes go one after another, in the order the events came.
      const stop = await hub.listen(inboxChannel(access.orgId), (raw) => {
        queue = queue.then(async () => {
          if (closed) return;
          try {
            const event = JSON.parse(raw) as InboxEvent;
            if (await allowed(event)) await stream.writeSSE({ event: event.type, data: raw });
          } catch {
            // A malformed hint is dropped; the next one refreshes the view anyway.
          }
        });
      });

      stream.onAbort(() => {
        closed = true;
      });

      try {
        await stream.writeSSE({ event: "ready", data: "{}", retry: 3000 });
        while (!closed) {
          await stream.sleep(HEARTBEAT_MS);
          if (!closed) await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally {
        stop();
      }
    });
  });

  return {
    app,
    /** Open streams, subscribed organizations and cached people on this process, for health checks. */
    stats: () => ({ ...hub.stats(), people: reach.size() }),
    close: () => hub.close(),
  };
}
