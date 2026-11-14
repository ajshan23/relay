import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GraphError } from "../src/meta/errors";
import { smbSyncFailure } from "../src/whatsapp/onboarding";
import { parseWhatsAppWebhook } from "../src/whatsapp/parse";

// biome-ignore lint/suspicious/noExplicitAny: tests reach into whichever event variant came back
type Loose = Record<string, any>;

const WABA = "900000000000001";
const PHONE_ID = "800000000000001";
const BIZ = "919847000001";

/** Payloads as Meta documents them (embedded-signup/onboarding-business-app-users). */
const hook = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: WABA,
      changes: [
        {
          field,
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: BIZ, phone_number_id: PHONE_ID },
            ...value,
          },
        },
      ],
    },
  ],
});

describe("WhatsApp coexistence webhooks", () => {
  it("reads the phone app's contacts, BSUID first, username-only included", () => {
    const [ev] = parseWhatsAppWebhook(
      hook("smb_app_state_sync", {
        state_sync: [
          {
            type: "contact",
            action: "add",
            metadata: { timestamp: "1730000000" },
            contact: {
              full_name: "Anil Kumar",
              first_name: "Anil",
              phone_number: "+91 98470 00101",
              user_id: "IN.111",
            },
          },
          {
            type: "contact",
            action: "add",
            contact: { full_name: "No Phone", user_id: "IN.222", username: "nophone" },
          },
          { type: "contact", action: "remove", contact: { phone_number: "919847000103" } },
        ],
      }),
    ) as Loose[];
    assert.equal(ev?.kind, "contacts.synced");
    assert.equal(ev?.scope, WABA);
    assert.equal(ev?.accountExternalId, PHONE_ID);
    assert.deepEqual(
      ev?.contacts.map((c: Loose) => [
        c.action,
        c.identity.externalId,
        c.identity.phone,
        c.identity.username,
        c.fullName,
      ]),
      [
        ["add", "IN.111", "919847000101", null, "Anil Kumar"],
        ["add", "IN.222", null, "nophone", "No Phone"],
        ["remove", "919847000103", "919847000103", null, null],
      ],
    );
  });

  it("imports history: direction from the business number, placeholders for old media, progress per chunk", () => {
    const events = parseWhatsAppWebhook(
      hook("history", {
        history: [
          {
            metadata: { phase: 0, chunk_order: 2, progress: 55 },
            threads: [
              {
                id: "919847000101",
                messages: [
                  {
                    id: "w1",
                    from: "919847000101",
                    from_user_id: "IN.111",
                    timestamp: "1730000000",
                    type: "text",
                    text: { body: "Hi" },
                    history_context: { status: "read" },
                  },
                  {
                    id: "w2",
                    from: BIZ,
                    to: "919847000101",
                    timestamp: "1730000100",
                    type: "text",
                    text: { body: "Hello!" },
                    history_context: { status: "delivered" },
                  },
                  {
                    id: "w3",
                    from: "919847000101",
                    from_user_id: "IN.111",
                    timestamp: "1730000200",
                    type: "media_placeholder",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ) as Loose[];
    const msgs = events.filter((e) => e.kind === "message.phone_app");
    assert.deepEqual(
      msgs.map((m) => [
        m.externalId,
        m.direction,
        m.customer.externalId,
        m.customer.phone,
        m.content.type,
        m.status,
      ]),
      [
        ["w1", "inbound", "IN.111", "919847000101", "text", "read"],
        ["w2", "outbound", "IN.111", "919847000101", "text", "delivered"],
        ["w3", "inbound", "IN.111", "919847000101", "unsupported", null],
      ],
    );
    const progress = events.find((e) => e.kind === "history.progress");
    assert.deepEqual(
      [progress?.phase, progress?.chunkOrder, progress?.progress, progress?.messages],
      [0, 2, 55, 3],
    );
  });

  it("reports a declined history (2593109) as progress with the error", () => {
    const [ev] = parseWhatsAppWebhook(
      hook("history", {
        history: [{ errors: [{ code: 2593109, title: "Declined", message: "History sharing is off" }] }],
      }),
    ) as Loose[];
    assert.equal(ev?.kind, "history.progress");
    assert.equal(ev?.errors[0].code, 2593109);
  });

  it("turns phone-app replies into outbound messages, even without the customer's phone", () => {
    const [ev] = parseWhatsAppWebhook(
      hook("smb_message_echoes", {
        contacts: [{ profile: { username: "realsheena" }, user_id: "IN.333" }],
        message_echoes: [
          {
            from: BIZ,
            to_user_id: "IN.333",
            id: "wamid.E1",
            timestamp: "1730000300",
            type: "text",
            text: { body: "On my way" },
          },
        ],
      }),
    ) as Loose[];
    assert.equal(ev?.kind, "message.phone_app");
    assert.equal(ev?.source, "echo");
    assert.equal(ev?.direction, "outbound");
    assert.deepEqual(
      [ev?.customer.externalId, ev?.customer.phone, ev?.customer.username],
      ["IN.333", null, "realsheena"],
    );
    assert.equal(ev?.content.text, "On my way");
  });

  it("gives account_update events their business account", () => {
    const [ev] = parseWhatsAppWebhook(
      hook("account_update", { event: "PARTNER_REMOVED", waba_info: { waba_id: WABA } }),
    ) as Loose[];
    assert.equal(ev?.kind, "account.update");
    assert.equal(ev?.scope, WABA);
    assert.equal(ev?.data.event, "PARTNER_REMOVED");
  });

  it("classifies sync failures like FlowFlex did", () => {
    const g = (code: number, msg: string) => new GraphError(msg, "permanent", 400, code, undefined);
    assert.equal(smbSyncFailure(g(2593109, "declined")), "declined");
    assert.equal(smbSyncFailure(g(100, "Request is outside of allowed time window")), "expired");
    assert.equal(smbSyncFailure(new GraphError("busy", "retryable", 500, 1, undefined)), "retry");
    assert.equal(
      smbSyncFailure(new GraphError("Invalid OAuth access token data.", "authFailed", 401, 190, undefined)),
      "failed",
    );
  });
});
