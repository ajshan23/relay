import { automationEvents, type LinkTappedPayload } from "@relay/core/automations";
import { eq, recordLinkTap, schema, sqlExecutor } from "@relay/db";
import { Hono } from "hono";
import type { AppContext } from "../../context";

/*
 * Tracked links of "Send link button" steps: GET /l/<code> counts the tap and forwards to the page.
 * Public (the customer's phone opens it); the web app forwards /l/* here. The first real tap wakes a run
 * waiting for it. Link previews and HEAD requests are forwarded without counting.
 */

/** Link-preview fetchers and crawlers, which open links nobody tapped. A real browser says Mozilla. */
export function isPreviewFetch(method: string, userAgent: string): boolean {
  if (method !== "GET") return true;
  if (!/Mozilla\//.test(userAgent)) return true;
  return /facebookexternalhit|facebookcatalog|\bbot\b|bot\/|crawler|spider|preview|Slackbot|TelegramBot|Discordbot|Twitterbot|LinkedInBot|Googlebot|bingbot|WhatsApp\//i.test(
    userAgent,
  );
}

const gone = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not found</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#333"><p>This link doesn't work any more.</p></body></html>`;

export function linkRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/:code", async (c) => {
    const code = c.req.param("code");
    if (!/^[\w-]{6,40}$/.test(code)) return c.html(gone, 404);
    const counted = !isPreviewFetch(c.req.method, c.req.header("user-agent") ?? "");
    let url: string | null = null;
    if (counted) {
      const tapped = await recordLinkTap(ctx.db, code, async (tx, link) => {
        const payload: LinkTappedPayload = { linkId: link.id, at: new Date().toISOString() };
        await ctx.kairos.publish(
          {
            tenantId: link.organizationId,
            key: automationEvents.linkTapped,
            scope: link.stepKey,
            payload,
            dedupeKey: `link:${link.code}`,
          },
          { executor: sqlExecutor(tx) },
        );
      });
      url = tapped?.url ?? null;
    } else {
      const [row] = await ctx.db
        .select({ url: schema.trackedLink.url })
        .from(schema.trackedLink)
        .where(eq(schema.trackedLink.code, code))
        .limit(1);
      url = row?.url ?? null;
    }
    if (!url) return c.html(gone, 404);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(url, 302);
  });

  return app;
}
