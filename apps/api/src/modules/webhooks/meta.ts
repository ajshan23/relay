import { createHash } from "node:crypto";
import { verifyMetaHandshake, verifyMetaSignature } from "@relay/channels";
import { newId } from "@relay/core";
import { schema } from "@relay/db";
import { Hono } from "hono";
import type { AppContext } from "../../context";

/*
 * The single webhook endpoint for every Meta product (WhatsApp, Instagram, Messenger).
 * It only checks the signature, stores the raw payload and queues it; the worker does the rest,
 * so Meta always gets a fast 200. Mounted at /webhooks/meta, outside /api, because Meta calls the
 * API directly (through ngrok while developing).
 */
export function metaWebhookRoutes(ctx: AppContext) {
  const app = new Hono();
  const { META_APP_SECRET: appSecret, META_VERIFY_TOKEN: verifyToken } = ctx.config;

  // Meta calls this once when the webhook URL is saved in the app settings.
  app.get("/", (c) => {
    if (!verifyToken) return c.text("Webhook verify token is not configured", 503);
    const challenge = verifyMetaHandshake(c.req.query(), verifyToken);
    return challenge === null ? c.text("Forbidden", 403) : c.text(challenge, 200);
  });

  app.post("/", async (c) => {
    if (!appSecret) return c.text("Webhook app secret is not configured", 503);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), appSecret)) {
      // Not from Meta (or tampered with). Nothing is stored.
      return c.text("Invalid signature", 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    } catch {
      return c.text("Body is not JSON", 400);
    }

    // Meta retries until it gets a 200, so the same body can arrive more than once: store it once.
    const dedupeKey = createHash("sha256").update(raw).digest("hex");
    const id = newId("webhookEvent");
    const inserted = await ctx.db
      .insert(schema.webhookEvent)
      .values({
        id,
        provider: "meta",
        object: typeof payload.object === "string" ? payload.object : null,
        dedupeKey,
        payload,
      })
      .onConflictDoNothing()
      .returning({ id: schema.webhookEvent.id });

    if (inserted.length) {
      await ctx.queues.webhooks.add("meta", { eventId: id }, { jobId: id, ...webhookJobOptions });
    }
    return c.text("OK", 200);
  });

  return app;
}

/** Processing retries with backoff; the raw event stays in webhook_event either way, for replay. */
export const webhookJobOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const;
