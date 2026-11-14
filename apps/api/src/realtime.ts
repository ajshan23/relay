import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createContext } from "./context";
import { eventRoutes } from "./modules/events/routes";

/*
 * The realtime process: only GET /api/events, the live update streams browsers keep open. Separate
 * from the main API (src/index.ts) so that thousands of idle connections never compete with ordinary
 * requests, it can be scaled on its own (streams are independent, no sticky sessions needed), and the
 * API can be deployed without dropping everyone's connection. Same code, sessions and Redis as the API.
 *
 * Run with `pnpm --filter @relay/realtime dev` (part of `pnpm dev`). The web app sends /api/events here
 * (REALTIME_URL); everything else under /api goes to the API.
 */

const ctx = createContext();
const events = eventRoutes(ctx);

const app = new Hono();
app.use(cors({ origin: ctx.config.WEB_URL, credentials: true }));
app.get("/health", (c) => c.json({ ok: true, ...events.stats() }));
app.route("/api/events", events.app);
app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

const server = serve(
  { fetch: app.fetch, port: ctx.config.REALTIME_PORT, hostname: ctx.config.HOST },
  (info) => {
    console.log(`realtime listening on http://${ctx.config.HOST}:${info.port}`);
  },
);

async function shutdown() {
  // Open streams end here; browsers reconnect on their own (EventSource retries) to another process.
  server.close();
  events.close();
  await ctx.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
