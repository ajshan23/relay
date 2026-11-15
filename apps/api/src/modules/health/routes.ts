import { sql } from "@relay/db";
import { Hono } from "hono";
import type { AppContext } from "../../context";

export function healthRoutes(ctx: AppContext) {
  const app = new Hono();

  // Liveness: the process is up.
  app.get("/", (c) => c.json({ ok: true }));

  // Readiness: the process can reach Postgres and Redis.
  app.get("/ready", async (c) => {
    const [postgres, redis] = await Promise.allSettled([
      ctx.db.execute(sql`select 1`),
      ctx.redis.info("memory"),
    ]);
    const info = redis.status === "fulfilled" ? redis.value : "";
    const read = (key: string) => Number(new RegExp(`^${key}:(\\d+)`, "m").exec(info)?.[1] ?? 0);
    const max = read("maxmemory");
    const checks = {
      postgres: postgres.status === "fulfilled",
      redis: redis.status === "fulfilled",
      /** Share of Redis maxmemory in use (null when no limit is set). Jobs fail when it reaches 1. */
      redisMemory: max ? Math.round((read("used_memory") / max) * 100) / 100 : null,
    };
    // Without Redis, pages and webhooks still work (Postgres first); background work waits. Report it,
    // but stay "ready" so the load balancer keeps sending traffic.
    const ok = checks.postgres;
    return c.json({ ok, checks }, ok ? 200 : 503);
  });

  return app;
}
