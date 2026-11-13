import { type InboxEvent, inboxChannel } from "@relay/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Redis } from "ioredis";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, requireOrg } from "../branches/access";
import { reachableBranches } from "../conversations/access";

/*
 * GET /api/events: live updates for the open inbox, as Server-Sent Events.
 * The worker and the API publish small hints to Redis (see @relay/core inbox.ts); this forwards the
 * ones about conversations the caller can reach. The browser refetches what it shows, so a missed
 * event only delays a refresh, and on reconnect the browser refetches everything.
 */

const HEARTBEAT_MS = 25_000;
const BRANCHES_REFRESH_MS = 60_000;

export function eventRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));
  // Proxies (the web app's /api rewrite in development, CDNs later) must pass events through as they
  // come: no compression (no-transform), no buffering. Set after the handler; streamSSE sets its own.
  app.use(async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-cache, no-transform");
    c.res.headers.set("X-Accel-Buffering", "no");
  });

  app.get("/", (c) => {
    const access = c.var.access;
    return streamSSE(c, async (stream) => {
      // A subscribed Redis connection can do nothing else, so each stream gets its own.
      const sub = new Redis(ctx.config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
      let branches = await reachableBranches(ctx, access);
      let branchesAt = Date.now();
      let closed = false;

      const allowed = async (event: InboxEvent) => {
        if (event.type === "template.updated") return true; // templates are organization-wide
        if (event.type === "conversation.read" && event.userId !== access.userId) return false;
        if (Date.now() - branchesAt > BRANCHES_REFRESH_MS) {
          branches = await reachableBranches(ctx, access);
          branchesAt = Date.now();
        }
        if (branches === null) return true;
        return !!event.branchId && branches.includes(event.branchId);
      };

      sub.on("message", async (_channel, raw) => {
        if (closed) return;
        try {
          const event = JSON.parse(raw) as InboxEvent;
          if (await allowed(event)) await stream.writeSSE({ event: event.type, data: raw });
        } catch {
          // A malformed hint is dropped; the next one refreshes the view anyway.
        }
      });

      stream.onAbort(() => {
        closed = true;
      });

      await sub.connect();
      await sub.subscribe(inboxChannel(access.orgId));
      await stream.writeSSE({ event: "ready", data: "{}", retry: 3000 });
      while (!closed) {
        await stream.sleep(HEARTBEAT_MS);
        if (!closed) await stream.writeSSE({ event: "ping", data: "{}" });
      }
      sub.disconnect();
    });
  });

  return app;
}
