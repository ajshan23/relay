import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyGraphError } from "../src/meta/errors";
import { signMetaPayload, verifyMetaHandshake, verifyMetaSignature } from "../src/meta/signature";
import { shouldApplyStatus, toStoredStatus, windowExpiresAt } from "../src/status";
import { buildWhatsAppSendBody } from "../src/whatsapp/send";

describe("Meta signature", () => {
  const body = '{"object":"whatsapp_business_account"}';
  it("accepts the right signature and rejects anything else", () => {
    const header = signMetaPayload(body, "secret");
    assert.equal(verifyMetaSignature(body, header, "secret"), true);
    assert.equal(verifyMetaSignature(body, header, "other"), false);
    assert.equal(verifyMetaSignature(`${body} `, header, "secret"), false);
    assert.equal(verifyMetaSignature(body, "sha256=00", "secret"), false);
    assert.equal(verifyMetaSignature(body, null, "secret"), false);
  });
  it("answers the handshake only for our verify token", () => {
    assert.equal(
      verifyMetaHandshake({ "hub.mode": "subscribe", "hub.verify_token": "t", "hub.challenge": "42" }, "t"),
      "42",
    );
    assert.equal(
      verifyMetaHandshake({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "42" }, "t"),
      null,
    );
    assert.equal(verifyMetaHandshake({ "hub.mode": "other", "hub.verify_token": "t" }, "t"), null);
  });
});

describe("Graph error classification", () => {
  it("maps the documented codes", () => {
    assert.equal(classifyGraphError(131047, 400), "windowClosed");
    assert.equal(classifyGraphError(130429, 400), "rateLimited");
    assert.equal(classifyGraphError(131056, 400), "rateLimited");
    assert.equal(classifyGraphError(190, 401), "authFailed");
    assert.equal(classifyGraphError(131026, 400), "permanent");
    assert.equal(classifyGraphError(undefined, 503), "retryable");
    assert.equal(classifyGraphError(undefined, 429), "rateLimited");
  });
});

describe("Status ordering", () => {
  it("only moves forward, even when webhooks arrive out of order", () => {
    assert.equal(shouldApplyStatus("accepted", "sent"), true);
    assert.equal(shouldApplyStatus("read", "delivered"), false);
    assert.equal(shouldApplyStatus("accepted", "read"), true);
    assert.equal(shouldApplyStatus("sent", "sent"), false);
  });
  it("keeps failed final unless delivery is later proven", () => {
    assert.equal(shouldApplyStatus("failed", "sent"), false);
    assert.equal(shouldApplyStatus("failed", "delivered"), true);
    assert.equal(shouldApplyStatus("delivered", "failed"), false);
    assert.equal(shouldApplyStatus("accepted", "failed"), true);
  });
  it("treats played as read and computes the 24-hour window", () => {
    assert.equal(toStoredStatus("played"), "read");
    assert.equal(
      windowExpiresAt(new Date("2026-11-13T10:00:00Z"), 24).toISOString(),
      "2026-11-14T10:00:00.000Z",
    );
  });
});

describe("WhatsApp send body", () => {
  it("builds a text reply with our id for status matching", () => {
    const body = buildWhatsAppSendBody(
      { phone: "15550001111", userId: "US.1" },
      { type: "text", text: "Hello", replyToExternalId: "wamid.in" },
      "msg_1",
    );
    assert.deepEqual(body, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15550001111",
      biz_opaque_callback_data: "msg_1",
      context: { message_id: "wamid.in" },
      type: "text",
      text: { body: "Hello", preview_url: false },
    });
  });
  it("sends by BSUID when the phone is hidden, and builds media", () => {
    const body = buildWhatsAppSendBody(
      { phone: null, userId: "US.1" },
      { type: "document", providerMediaId: "M1", caption: "c", fileName: "a.pdf" },
      "msg_2",
    );
    assert.equal(body.recipient, "US.1");
    assert.equal(body.to, undefined);
    assert.deepEqual(body.document, { id: "M1", caption: "c", filename: "a.pdf" });
  });
});
