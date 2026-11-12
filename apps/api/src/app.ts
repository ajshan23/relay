import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { AppContext } from "./context";
import { auth } from "./modules/auth/auth";
import { authOptionsRoutes } from "./modules/auth/routes";
import { branchRoutes } from "./modules/branches/routes";
import { conversationRoutes } from "./modules/conversations/routes";
import { healthRoutes } from "./modules/health/routes";
import { meRoutes } from "./modules/me/routes";
import { metaWebhookRoutes } from "./modules/webhooks/meta";

/**
 * One module per folder under src/modules. A module owns its routes, logic and queries,
 * and other modules use it only through what it exports.
 *
 * Everything the browser calls lives under /api, which the web app proxies to this server.
 */
export function createApp(ctx: AppContext) {
  const app = new Hono();

  app.use(logger());
  app.use(cors({ origin: ctx.config.WEB_URL, credentials: true }));

  app.route("/health", healthRoutes(ctx));
  app.route("/webhooks/meta", metaWebhookRoutes(ctx));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route("/api/auth-options", authOptionsRoutes());
  app.route("/api/me", meRoutes(ctx));
  app.route("/api/branches", branchRoutes(ctx));
  app.route("/api/conversations", conversationRoutes(ctx));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
