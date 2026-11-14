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
 * Embedded Signup + coexistence: POST /_signup, then the popup's code works at /oauth/access_token;
 * smb_app_data sends contact sync, out-of-order history chunks and (POST /_echo) phone-app replies.
 *
 * Broadcast drills (Meta's behaviour at scale, without a real number):
 *   - after each accepted message, signed status webhooks: sent, delivered (+0.5 s), read (+1 s)
 *     (FAKE_STATUS_WEBHOOKS=0 turns them off)
 *   POST /_faults   [{ code, every?, ratio?, to?, async?, message? }]  every Nth (or a share of, or
 *                   these numbers') messages
 *   POST /_reads    { "<template name>": 0.3 }  share of that template's messages that get "read"
 *                   fail with that Meta error: at once (HTTP error) or later (a failed status webhook)
 *   POST /_limit    { tier: "TIER_2K" | "TIER_UNLIMITED" | ..., quality?: "GREEN" | "RED" }
 *   POST /_webhook  { wabaId, field, value }  sends any signed webhook (template paused, quality, …)
 *   GET  /_stats    messages accepted, the busiest second per number, and the faults hit
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

/** Signs and posts a webhook to Relay's API, like Meta. */
async function deliver(payload: unknown) {
  const body = JSON.stringify(payload);
  const secret = process.env.META_APP_SECRET ?? "";
  return fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(body, secret) },
    body,
  }).catch((err) => console.error("webhook not delivered", err.message));
}

/* ------------------------------------------------------------------ broadcast drills */

type Fault = {
  code: number;
  every?: number;
  ratio?: number;
  to?: string[];
  async?: boolean;
  message?: string;
};
let faults: Fault[] = [];
let readRates: Record<string, number> = {};
let tier = process.env.FAKE_TIER ?? "TIER_UNLIMITED";
let quality = "GREEN";
const stats = { accepted: 0, failedSync: 0, failedAsync: 0, perSecond: new Map<string, number>(), peak: 0 };
const STATUS_WEBHOOKS = process.env.FAKE_STATUS_WEBHOOKS !== "0";

app.post("/_faults", async (c) => {
  faults = (await c.req.json()) as Fault[];
  return c.json({ faults });
});
app.post("/_reads", async (c) => {
  readRates = (await c.req.json()) as Record<string, number>;
  return c.json({ readRates });
});
app.post("/_limit", async (c) => {
  const b = (await c.req.json()) as { tier?: string; quality?: string };
  tier = b.tier ?? tier;
  quality = b.quality ?? quality;
  return c.json({ tier, quality });
});
app.post("/_webhook", async (c) => {
  const b = (await c.req.json()) as { wabaId: string; field: string; value: unknown };
  const res = await deliver({
    object: "whatsapp_business_account",
    entry: [
      { id: b.wabaId, time: Math.floor(Date.now() / 1000), changes: [{ field: b.field, value: b.value }] },
    ],
  });
  return c.json({ delivered: res ? res.status : 0 });
});
app.get("/_stats", (c) =>
  c.json({
    accepted: stats.accepted,
    failedSync: stats.failedSync,
    failedAsync: stats.failedAsync,
    peakPerSecond: stats.peak,
  }),
);
app.post("/_reset", (c) => {
  faults = [];
  readRates = {};
  stats.accepted = stats.failedSync = stats.failedAsync = stats.peak = 0;
  stats.perSecond.clear();
  return c.json({ ok: true });
});

/** The fault (if any) this message hits. */
function faultFor(n: number, to: string) {
  return faults.find((f) =>
    f.to ? f.to.includes(to) : f.every ? n % f.every === 0 : f.ratio ? Math.random() < f.ratio : false,
  );
}

/** Sent, delivered, read, or failed: like Meta's status webhooks for one message. */
function statusWebhooks(
  phoneId: string,
  wamid: string,
  to: string,
  ours: string | undefined,
  fail?: Fault,
  readRate = 1,
) {
  if (!STATUS_WEBHOOKS) return;
  const send = (status: string, delay: number, errors?: unknown[]) =>
    setTimeout(
      () =>
        void deliver({
          object: "whatsapp_business_account",
          entry: [
            {
              id: "100000000000001",
              changes: [
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: { display_phone_number: "15550009999", phone_number_id: phoneId },
                    statuses: [
                      {
                        id: wamid,
                        status,
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        recipient_id: to,
                        ...(ours ? { biz_opaque_callback_data: ours } : {}),
                        ...(errors ? { errors } : {}),
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      delay,
    );
  if (fail) {
    send("failed", 300, [
      {
        code: fail.code,
        title: fail.message ?? `Error ${fail.code}`,
        message: fail.message ?? `Error ${fail.code}`,
      },
    ]);
    return;
  }
  send("sent", 200);
  send("delivered", 600);
  if (Math.random() < readRate) send("read", 1200);
}

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
  const phoneId = c.req.param("phoneId");
  const body = (await c.req.json()) as {
    type?: string;
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
  const fault = faultFor(counter, body.to ?? "");
  if (fault && !fault.async) {
    stats.failedSync++;
    return graphError(fault.code, fault.message ?? `Error ${fault.code}`);
  }
  // Busiest second per number, to check broadcasts stay under the speed limit.
  const second = `${phoneId}:${Math.floor(Date.now() / 1000)}`;
  const inSecond = (stats.perSecond.get(second) ?? 0) + 1;
  stats.perSecond.set(second, inSecond);
  stats.peak = Math.max(stats.peak, inSecond);
  if (stats.perSecond.size > 5000) stats.perSecond.clear();
  stats.accepted++;
  const wamid = `wamid.fake.${Date.now()}.${counter}`;
  if (fault?.async) stats.failedAsync++;
  if (body.type === "template" || !body.text?.body?.includes("#"))
    statusWebhooks(
      phoneId,
      wamid,
      body.to ?? "",
      body.biz_opaque_callback_data,
      fault,
      readRates[(body as { template?: { name?: string } }).template?.name ?? ""] ?? 1,
    );
  return c.json({
    messaging_product: "whatsapp",
    contacts: [{ input: body.to ?? body.recipient, wa_id: body.to ?? "" }],
    messages: [{ id: wamid }],
  });
});

/* ------------------------------------------------------------------ Embedded Signup + coexistence */

/*
 * POST /_signup { code, wabaId, phoneId, businessId?, coexistence?, phone?, faults? } registers what a
 * business "picked" in Meta's popup; the code then works once at /oauth/access_token.
 * faults: { subscribe?: code, register?: code, historyDeclined?: true }
 * POST /_echo { phoneId, wabaId, to, text } sends a smb_message_echoes webhook (reply from the phone app).
 */
type FakeSignup = {
  code: string;
  wabaId: string;
  phoneId: string;
  businessId: string;
  coexistence: boolean;
  phone: string;
  faults: { subscribe?: number; register?: number; historyDeclined?: boolean };
};
const signups = new Map<string, FakeSignup>(); // by code
const signupTokens = new Map<string, FakeSignup>(); // by token
const signupPhones = new Map<string, FakeSignup>(); // by phone id
const signupWabas = new Map<string, FakeSignup>(); // by waba id

app.post("/_signup", async (c) => {
  const b = (await c.req.json()) as Partial<FakeSignup>;
  const s: FakeSignup = {
    code: b.code ?? `code-${Date.now()}`,
    wabaId: b.wabaId ?? "900000000000001",
    phoneId: b.phoneId ?? "800000000000001",
    businessId: b.businessId ?? "700000000000001",
    coexistence: b.coexistence ?? false,
    phone: b.phone ?? "+91 98470 00001",
    faults: b.faults ?? {},
  };
  signups.set(s.code, s);
  signupPhones.set(s.phoneId, s);
  signupWabas.set(s.wabaId, s);
  return c.json(s);
});

app.get("/:version/oauth/access_token", (c) => {
  const s = signups.get(c.req.query("code") ?? "");
  if (!s || !c.req.query("client_secret")) return graphError(100, "Invalid verification code format.");
  signups.delete(s.code); // a code works once
  const token = `FAKE-BISU-${s.wabaId}-${Date.now()}`;
  signupTokens.set(token, s);
  return c.json({ access_token: token, token_type: "bearer" });
});

app.get("/:version/debug_token", (c) => {
  const s = signupTokens.get(c.req.query("input_token") ?? "");
  if (!s) return c.json({ data: { is_valid: false, scopes: [], granular_scopes: [] } });
  return c.json({
    data: {
      is_valid: true,
      expires_at: 0,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging", "business_management"],
      granular_scopes: [
        { scope: "whatsapp_business_management", target_ids: [s.wabaId] },
        { scope: "whatsapp_business_messaging", target_ids: [s.wabaId] },
        { scope: "business_management", target_ids: [s.businessId] },
      ],
    },
  });
});

const fakePhone = (s: FakeSignup, registered: boolean) => ({
  id: s.phoneId,
  display_phone_number: s.phone,
  verified_name: "Fake Clinic",
  status: s.coexistence || registered ? "CONNECTED" : "PENDING",
  code_verification_status: "VERIFIED",
  name_status: "APPROVED",
  platform_type: s.coexistence || registered ? "CLOUD_API" : "NOT_APPLICABLE",
  is_on_biz_app: s.coexistence,
  quality_rating: "GREEN",
  throughput: { level: s.coexistence ? "STANDARD" : "STANDARD" },
  whatsapp_business_manager_messaging_limit: "TIER_250",
});
const registered = new Set<string>();

app.get("/:version/:wabaId/phone_numbers", (c) => {
  const s = signupWabas.get(c.req.param("wabaId"));
  return c.json({ data: s ? [fakePhone(s, registered.has(s.phoneId))] : [], paging: {} });
});

app.post("/:version/:phoneId/register", async (c) => {
  await record(c);
  const s = signupPhones.get(c.req.param("phoneId"));
  if (s?.faults.register) return graphError(s.faults.register, "Registration failed (fake)");
  registered.add(c.req.param("phoneId"));
  return c.json({ success: true });
});

/** Signed coexistence webhooks, as Meta sends them after a smb_app_data request. */
function coexistenceWebhook(s: FakeSignup, field: string, value: Record<string, unknown>) {
  return deliver({
    object: "whatsapp_business_account",
    entry: [
      {
        id: s.wabaId,
        changes: [
          {
            field,
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: s.phone.replace(/\D/g, ""), phone_number_id: s.phoneId },
              ...value,
            },
          },
        ],
      },
    ],
  });
}

app.post("/:version/:phoneId/smb_app_data", async (c) => {
  await record(c);
  const s = signupPhones.get(c.req.param("phoneId"));
  const body = (await c.req.json().catch(() => ({}))) as { sync_type?: string };
  if (!s) return graphError(100, "Unknown phone number");
  const requestId = `sync-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  if (body.sync_type === "smb_app_state_sync") {
    setTimeout(() => {
      void coexistenceWebhook(s, "smb_app_state_sync", {
        state_sync: [
          {
            type: "contact",
            action: "add",
            metadata: { timestamp: String(now) },
            contact: {
              full_name: "Anil Kumar",
              first_name: "Anil",
              phone_number: "919847000101",
              user_id: "IN.FAKE0101",
            },
          },
          {
            type: "contact",
            action: "add",
            metadata: { timestamp: String(now) },
            contact: {
              full_name: "Sara Thomas",
              first_name: "Sara",
              phone_number: "919847000102",
              user_id: "IN.FAKE0102",
            },
          },
          {
            type: "contact",
            action: "add",
            metadata: { timestamp: String(now) },
            contact: { full_name: "Username Only", user_id: "IN.FAKE0103", username: "username.only" },
          },
        ],
      });
    }, 1500);
  } else if (body.sync_type === "history") {
    if (s.faults.historyDeclined) {
      setTimeout(() => {
        void coexistenceWebhook(s, "history", {
          history: [
            {
              errors: [
                {
                  code: 2593109,
                  title: "History sharing declined",
                  message: "The business declined to share chat history",
                },
              ],
            },
          ],
        });
      }, 1500);
    } else {
      const day = 86400;
      const msg = (id: string, from: string, ts: number, body: string, status = "read", to?: string) => ({
        id,
        from,
        ...(to ? { to } : { from_user_id: "IN.FAKE0101" }),
        timestamp: String(ts),
        type: "text",
        text: { body },
        history_context: { status },
      });
      const biz = s.phone.replace(/\D/g, "");
      // Sent out of order on purpose: chunk 2 (older) before chunk 1, then the final progress 100.
      const chunks = [
        {
          metadata: { phase: 1, chunk_order: 2, progress: 60 },
          threads: [
            {
              id: "919847000102",
              messages: [
                msg("wamid.HIST.0201", "919847000102", now - 40 * day, "Is the clinic open on Sunday?"),
                msg("wamid.HIST.0202", biz, now - 40 * day + 600, "Yes, 10 to 2.", "read", "919847000102"),
              ],
            },
          ],
        },
        {
          metadata: { phase: 0, chunk_order: 1, progress: 30 },
          threads: [
            {
              id: "919847000101",
              messages: [
                msg("wamid.HIST.0101", "919847000101", now - 2 * 3600, "Hi, can I book for tomorrow?"),
                msg("wamid.HIST.0102", biz, now - 3500, "Sure, 11 am works?", "delivered", "919847000101"),
                {
                  id: "wamid.HIST.0103",
                  from: "919847000101",
                  from_user_id: "IN.FAKE0101",
                  timestamp: String(now - 3400),
                  type: "media_placeholder",
                  history_context: { status: "read" },
                },
              ],
            },
          ],
        },
        { metadata: { phase: 2, chunk_order: 3, progress: 100 }, threads: [] },
      ];
      for (const [i, chunk] of chunks.entries()) {
        setTimeout(() => void coexistenceWebhook(s, "history", { history: [chunk] }), 1500 + i * 700);
      }
    }
  }
  return c.json({ messaging_product: "whatsapp", request_id: requestId });
});

app.post("/_echo", async (c) => {
  const b = (await c.req.json()) as { phoneId: string; to: string; toUserId?: string; text: string };
  const s = signupPhones.get(b.phoneId);
  if (!s) return c.json({ error: "unknown phone" }, 404);
  await coexistenceWebhook(s, "smb_message_echoes", {
    contacts: [{ wa_id: b.to, user_id: b.toUserId ?? "IN.FAKE0101", profile: {} }],
    message_echoes: [
      {
        from: s.phone.replace(/\D/g, ""),
        to: b.to,
        to_user_id: b.toUserId ?? "IN.FAKE0101",
        id: `wamid.ECHO.${Date.now()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "text",
        text: { body: b.text },
      },
    ],
  });
  return c.json({ ok: true });
});

app.get("/:version/:id", (c) => {
  const s = signupPhones.get(c.req.param("id"));
  if (s) return c.json(fakePhone(s, registered.has(s.phoneId)));
  return c.json({
    id: c.req.param("id"),
    display_phone_number: "+1 555 000 9999",
    verified_name: "Fake Business",
    quality_rating: quality,
    whatsapp_business_manager_messaging_limit: tier,
    url: `http://localhost:3299/_media/${c.req.param("id")}`,
    mime_type: "image/png",
    sha256: "FAKE",
  });
});
app.post("/:version/:wabaId/subscribed_apps", async (c) => {
  await record(c);
  const s = signupWabas.get(c.req.param("wabaId"));
  if (s?.faults.subscribe) return graphError(s.faults.subscribe, "Subscription failed (fake)");
  return c.json({ success: true });
});
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
