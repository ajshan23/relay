/*
 * A stand-in for graph.facebook.com, for testing sending without a real WhatsApp number.
 * Point the worker at it with META_GRAPH_URL=http://localhost:3299 (and a short META_GRAPH_TIMEOUT_MS).
 *   pnpm --filter @relay/worker fake-graph
 * What it does depends on the message text:
 *   "#window"  -> error 131047 (24-hour window closed)
 *   "#rate"    -> error 130429 once, then accepted (tests retry)
 *   "#timeout" -> never answers (tests "uncertain, not resent")
 *   "#auth"    -> error 190 (token expired)
 *   anything else -> accepted with a new wamid
 * Groups: create/update/delete answer with a request_id (the result is a webhook: use the simulator),
 * invite links, join requests and participant removal answer like Meta.
 * Templates: created as PENDING, then 10 seconds later a signed message_template_status_update
 * webhook is sent to the API: APPROVED, or REJECTED when the name contains "reject". The UI tells
 * people review takes up to 2 hours; here it is quick on purpose. A ready-made hello_world exists.
 * GET /_requests lists what it received.
 */
import { serve } from "@hono/node-server";
import { signMetaPayload } from "@relay/channels";
import { Hono } from "hono";

const app = new Hono();
const received: { at: string; path: string; body: unknown }[] = [];
const rateHits = new Map<string, number>();
let counter = 0;

const graphError = (code: number, message: string, status = 400) =>
  new Response(JSON.stringify({ error: { message, type: "OAuthException", code, fbtrace_id: "FAKE" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

app.get("/_requests", (c) => c.json(received));

/* ------------------------------------------------------------------ templates */

type FakeTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejected_reason?: string;
  components: unknown[];
};
const templates = new Map<string, FakeTemplate>([
  [
    "1000000000000001",
    {
      id: "1000000000000001",
      name: "hello_world",
      language: "en_US",
      category: "UTILITY",
      status: "APPROVED",
      components: [
        { type: "HEADER", format: "TEXT", text: "Hello World" },
        {
          type: "BODY",
          text: "Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta. Thank you for taking the time to test with us.",
        },
        { type: "FOOTER", text: "WhatsApp Business Platform sample message" },
      ],
    },
  ],
]);
const REVIEW_MS = Number(process.env.FAKE_TEMPLATE_REVIEW_MS ?? 10_000);
const API = process.env.FAKE_WEBHOOK_TARGET ?? "http://localhost:3201/webhooks/meta";

/** Plays Meta's reviewer: decides after a short wait and tells Relay with a signed webhook. */
function review(wabaId: string, t: FakeTemplate) {
  setTimeout(async () => {
    const rejected = t.name.includes("reject");
    t.status = rejected ? "REJECTED" : "APPROVED";
    t.rejected_reason = rejected ? "INVALID_FORMAT" : undefined;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaId,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: "message_template_status_update",
              value: {
                event: t.status,
                message_template_id: Number(t.id),
                message_template_name: t.name,
                message_template_language: t.language,
                reason: rejected ? "INVALID_FORMAT" : "NONE",
              },
            },
          ],
        },
      ],
    });
    const secret = process.env.META_APP_SECRET ?? "";
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(body, secret) },
        body,
      });
      console.log(`template ${t.name}: ${t.status} (webhook ${res.status})`);
    } catch (err) {
      console.error(`template ${t.name}: could not reach the API`, err);
    }
  }, REVIEW_MS);
}

app.get("/:version/:wabaId/message_templates", (c) =>
  c.json({ data: [...templates.values()], paging: { cursors: { before: "a", after: "b" } } }),
);
app.post("/:version/:wabaId/message_templates", async (c) => {
  const body = (await c.req.json()) as {
    name?: string;
    language?: string;
    category?: string;
    components?: unknown[];
  };
  received.push({ at: new Date().toISOString(), path: c.req.path, body });
  if (!body.name || !/^[a-z0-9_]+$/.test(body.name)) return graphError(100, "Invalid parameter: name");
  if ([...templates.values()].some((t) => t.name === body.name && t.language === body.language))
    return graphError(100, "Content in this language already exists", 400);
  const id = String(1000000000000000 + Math.floor(Math.random() * 1e12));
  const t: FakeTemplate = {
    id,
    name: body.name,
    language: body.language ?? "en",
    category: body.category ?? "UTILITY",
    status: "PENDING",
    components: body.components ?? [],
  };
  templates.set(id, t);
  review(c.req.param("wabaId"), t);
  return c.json({ id, status: "PENDING", category: t.category });
});
app.delete("/:version/:wabaId/message_templates", (c) => {
  const id = c.req.query("hsm_id");
  received.push({
    at: new Date().toISOString(),
    path: c.req.path,
    body: { delete: c.req.query("name"), id },
  });
  if (id) templates.delete(id);
  return c.json({ success: true });
});
// Resumable upload for template header examples.
app.post("/:version/:appId/uploads", (c) => c.json({ id: `upload:FAKE${Date.now()}` }));

// A 1x1 PNG, for media download tests.
app.get("/_media/:id", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  return new Response(png, {
    headers: { "content-type": "image/png", "content-length": String(png.length) },
  });
});

const record = async (c: { req: { path: string; method: string; text: () => Promise<string> } }) => {
  const raw = await c.req.text();
  received.push({
    at: new Date().toISOString(),
    path: `${c.req.method} ${c.req.path}`,
    body: raw ? JSON.parse(raw) : null,
  });
};
let requestCounter = 0;
const requestId = () => `REQ.fake.${Date.now()}.${++requestCounter}`;

app.post("/:version/:phoneId/groups", async (c) => {
  await record(c);
  return c.json({ request_id: requestId() });
});
app.get("/:version/:groupId/invite_link", (c) =>
  c.json({ invite_link: `https://chat.whatsapp.com/FAKE${c.req.param("groupId").slice(-6)}` }),
);
app.post("/:version/:groupId/invite_link", async (c) => {
  await record(c);
  return c.json({ invite_link: `https://chat.whatsapp.com/RESET${Date.now()}` });
});
app.get("/:version/:groupId/join_requests", (c) => c.json({ data: [], paging: {} }));
app.post("/:version/:groupId/join_requests", async (c) => {
  await record(c);
  return c.json({ success: true });
});
app.delete("/:version/:groupId/join_requests", async (c) => {
  await record(c);
  return c.json({ success: true });
});
app.delete("/:version/:groupId/participants", async (c) => {
  await record(c);
  return c.json({ success: true });
});
app.delete("/:version/:groupId", async (c) => {
  await record(c);
  return c.json({ request_id: requestId() });
});

// File uploads for outbound media. A file named "*fail*" is refused, to test the error path.
app.post("/:version/:phoneId/media", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file") as File | null;
  received.push({
    at: new Date().toISOString(),
    path: c.req.path,
    body: { upload: file?.name ?? null, type: form.get("type"), size: file?.size ?? 0 },
  });
  if (!file) return graphError(100, "file is required");
  if (file.name.includes("fail")) return graphError(131053, "Media upload error: unsupported file");
  counter++;
  return c.json({ id: `media.fake.${Date.now()}.${counter}` });
});

app.post("/:version/:phoneId/messages", async (c) => {
  const body = (await c.req.json()) as {
    text?: { body?: string };
    biz_opaque_callback_data?: string;
    status?: string;
    to?: string;
    recipient?: string;
  };
  received.push({ at: new Date().toISOString(), path: c.req.path, body });
  if (body.status === "read") return c.json({ success: true });
  const text = body.text?.body ?? "";
  if (text.includes("#window"))
    return graphError(131047, "Re-engagement message: more than 24 hours have passed");
  if (text.includes("#auth"))
    return graphError(190, "Error validating access token: Session has expired", 401);
  if (text.includes("#timeout")) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return c.json({});
  }
  if (text.includes("#rate")) {
    const key = body.biz_opaque_callback_data ?? text;
    const hits = (rateHits.get(key) ?? 0) + 1;
    rateHits.set(key, hits);
    if (hits === 1) return graphError(130429, "Rate limit hit");
  }
  counter++;
  return c.json({
    messaging_product: "whatsapp",
    contacts: [{ input: body.to ?? body.recipient, wa_id: body.to ?? "" }],
    messages: [{ id: `wamid.fake.${Date.now()}.${counter}` }],
  });
});

app.get("/:version/:id", (c) =>
  c.json({
    id: c.req.param("id"),
    display_phone_number: "+1 555 000 9999",
    verified_name: "Fake Business",
    quality_rating: "GREEN",
    url: `http://localhost:3299/_media/${c.req.param("id")}`,
    mime_type: "image/png",
    sha256: "FAKE",
  }),
);
app.post("/:version/:wabaId/subscribed_apps", (c) => c.json({ success: true }));
app.post("/:version/:groupId", async (c) => {
  const id = c.req.param("groupId");
  // Upload session: return a file handle.
  if (id.startsWith("upload:")) return c.json({ h: `4::FAKE${Date.now()}` });
  // Editing a template: back to review, decided again shortly.
  const t = templates.get(id);
  if (t) {
    const body = (await c.req.json()) as { components?: unknown[]; category?: string };
    received.push({ at: new Date().toISOString(), path: c.req.path, body });
    t.components = body.components ?? t.components;
    t.category = body.category ?? t.category;
    t.status = "PENDING";
    review("FAKE_WABA", t);
    return c.json({ success: true });
  }
  await record(c);
  return c.json({ request_id: requestId() });
});
serve({ fetch: app.fetch, port: 3299 }, () => console.log("fake Graph API on http://localhost:3299"));
