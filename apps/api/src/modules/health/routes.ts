import { sql } from "@relay/db";
import { Hono } from "hono";
import type { AppContext } from "../../context";

export function healthRoutes(ctx: AppContext) {
  const app = new Hono();

  // Liveness: the process is up.
  app.get("/", (c) => c.json({ ok: true }));

  // Readiness: the process can reach Postgres and Redis.
  app.get("/ready", async (c) => {
    const [postgres, redis] = await Promise.allSettled([ctx.db.execute(sql`select 1`), ctx.redis.ping()]);
    const checks = {
      postgres: postgres.status === "fulfilled",
      redis: redis.status === "fulfilled",
    };
    const ok = checks.postgres && checks.redis;
    return c.json({ ok, checks }, ok ? 200 : 503);
  });

  return app;
}
