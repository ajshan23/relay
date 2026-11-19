import { StorageFullError } from "@relay/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { AppContext } from "./context";
import { agentRoutes } from "./modules/agents/routes";
import { auth } from "./modules/auth/auth";
import { authOptionsRoutes } from "./modules/auth/routes";
import { linkRoutes } from "./modules/automations/links";
import { automationRoutes } from "./modules/automations/routes";
import { googleCallbackRoutes } from "./modules/bookings/google";
import { bookingRoutes } from "./modules/bookings/routes";
import { branchRoutes } from "./modules/branches/routes";
import { broadcastRoutes } from "./modules/broadcasts/routes";
import { catalogRoutes } from "./modules/catalog/routes";
import { channelRoutes } from "./modules/channels/routes";
import { contactImportRoutes } from "./modules/contacts/imports";
import { contactListRoutes } from "./modules/contacts/lists";
import { contactFieldRoutes, contactRoutes, contactViewRoutes, tagRoutes } from "./modules/contacts/routes";
import { conversationRoutes } from "./modules/conversations/routes";
import { fileRoutes } from "./modules/files/routes";
import { groupRoutes } from "./modules/groups/routes";
import { healthRoutes } from "./modules/health/routes";
import { meRoutes } from "./modules/me/routes";
import { quickReplyRoutes } from "./modules/quick-replies/routes";
import { settingsRoutes } from "./modules/settings/routes";
import { templateRoutes } from "./modules/templates/routes";
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
  // Tracked links from automations' link buttons (public: customers' phones open them).
  app.route("/l", linkRoutes(ctx));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route("/api/auth-options", authOptionsRoutes());
  app.route("/api/me", meRoutes(ctx));
  app.route("/api/branches", branchRoutes(ctx));
  app.route("/api/conversations", conversationRoutes(ctx));
  app.route("/api/channels", channelRoutes(ctx));
  app.route("/api/groups", groupRoutes(ctx));
  app.route("/api/templates", templateRoutes(ctx));
  app.route("/api/quick-replies", quickReplyRoutes(ctx));
  app.route("/api/broadcasts", broadcastRoutes(ctx));
  app.route("/api/automations", automationRoutes(ctx));
  app.route("/api/agents", agentRoutes(ctx));
  // Google sends managers back here without ?branch=, so before the branch-scoped routes.
  app.route("/api/bookings/google/callback", googleCallbackRoutes(ctx));
  app.route("/api/bookings", bookingRoutes(ctx));
  app.route("/api/catalog", catalogRoutes(ctx));
  app.route("/api/settings", settingsRoutes(ctx));
  // Sub-paths first, so "/api/contacts/:id" doesn't swallow them.
  app.route("/api/contacts/fields", contactFieldRoutes(ctx));
  app.route("/api/contacts/views", contactViewRoutes(ctx));
  app.route("/api/contacts/lists", contactListRoutes(ctx));
  app.route("/api/contacts/imports", contactImportRoutes(ctx));
  app.route("/api/tags", tagRoutes(ctx));
  app.route("/api/contacts", contactRoutes(ctx));
  // Live updates (/api/events) are served by their own process: see src/realtime.ts.
  app.route("/api", fileRoutes(ctx));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    // Any upload past the business's storage limit, wherever it was stored.
    if (err instanceof StorageFullError) return c.json({ error: "storage_full", message: err.message }, 413);
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
