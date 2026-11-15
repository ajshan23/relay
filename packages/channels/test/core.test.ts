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
  it("keeps played (a voice note's first play) above read, and computes the 24-hour window", () => {
    assert.equal(toStoredStatus("played"), "played");
    assert.equal(shouldApplyStatus("read", "played"), true);
    assert.equal(shouldApplyStatus("played", "read"), false);
    assert.equal(shouldApplyStatus("played", "failed"), false);
    assert.equal(shouldApplyStatus("failed", "played"), true);
    assert.equal(
      windowExpiresAt(new Date("2026-11-13T10:00:00Z"), 24).toISOString(),
      "2026-11-14T10:00:00.000Z",
    );
  });
});

describe("WhatsApp send body", () => {
  it("sends to a group by its id", () => {
    const body = buildWhatsAppSendBody(
      { kind: "group", groupExternalId: "GROUP_1" },
      { type: "text", text: "Hi all" },
      "msg_g",
    );
    assert.equal(body.recipient_type, "group");
    assert.equal(body.to, "GROUP_1");
    assert.deepEqual(body.text, { body: "Hi all", preview_url: false });
  });
  it("builds a text reply with our id for status matching", () => {
    const body = buildWhatsAppSendBody(
      { kind: "direct", phone: "15550001111", userId: "US.1" },
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
      { kind: "direct", phone: null, userId: "US.1" },
      { type: "document", providerMediaId: "M1", caption: "c", fileName: "a.pdf" },
      "msg_2",
    );
    assert.equal(body.recipient, "US.1");
    assert.equal(body.to, undefined);
    assert.deepEqual(body.document, { id: "M1", caption: "c", filename: "a.pdf" });
  });
});

describe("WhatsApp reactions we send", async () => {
  const { buildWhatsAppSendBody } = await import("../src/whatsapp/send");
  it("sends a reaction to the message's id, never as a reply", () => {
    const body = buildWhatsAppSendBody(
      { kind: "direct", phone: "919847000101", userId: null },
      { type: "reaction", targetExternalId: "wamid.ABC", emoji: "👍", replyToExternalId: "wamid.X" },
      "msg_1",
    );
    assert.equal(body.type, "reaction");
    assert.deepEqual(body.reaction, { message_id: "wamid.ABC", emoji: "👍" });
    assert.equal(body.context, undefined);
    assert.equal(body.to, "919847000101");
  });
  it("removes our reaction with an empty emoji, and reaches username-only people by BSUID", () => {
    const body = buildWhatsAppSendBody(
      { kind: "direct", phone: null, userId: "IN.123" },
      { type: "reaction", targetExternalId: "wamid.ABC", emoji: "" },
      "msg_2",
    );
    assert.deepEqual(body.reaction, { message_id: "wamid.ABC", emoji: "" });
    assert.equal(body.recipient, "IN.123");
  });
});

describe("WhatsApp voice notes we send", async () => {
  const { buildWhatsAppSendBody } = await import("../src/whatsapp/send");
  it("marks recorded audio as a voice message, and leaves audio files as files", () => {
    const to = { kind: "direct" as const, phone: "919847000101", userId: null };
    const voice = buildWhatsAppSendBody(to, { type: "audio", providerMediaId: "M1", voice: true }, "m1");
    assert.deepEqual(voice.audio, { id: "M1", voice: true });
    const file = buildWhatsAppSendBody(to, { type: "audio", providerMediaId: "M2" }, "m2");
    assert.deepEqual(file.audio, { id: "M2" });
  });
});

describe("interactive messages", () => {
  const to = { kind: "direct" as const, phone: "919847000000", userId: null };
  it("sends up to three options as reply buttons, cutting long titles", () => {
    const body = buildWhatsAppSendBody(
      to,
      {
        type: "interactive",
        kind: "buttons",
        body: "What do you need?",
        options: [
          { id: "q1_a1", title: "Prices" },
          { id: "q1_a2", title: "A title that is far too long" },
        ],
      },
      "msg_1",
    ) as {
      type: string;
      interactive: { type: string; action: { buttons: { reply: { id: string; title: string } }[] } };
    };
    assert.equal(body.type, "interactive");
    assert.equal(body.interactive.type, "button");
    assert.deepEqual(body.interactive.action.buttons[0]?.reply, { id: "q1_a1", title: "Prices" });
    assert.equal(body.interactive.action.buttons[1]?.reply.title.length, 20);
  });
  it("sends more options as a list behind one button", () => {
    const body = buildWhatsAppSendBody(
      to,
      {
        type: "interactive",
        kind: "list",
        body: "Pick a branch",
        buttonText: "Branches",
        options: Array.from({ length: 5 }, (_, i) => ({ id: `q1_b${i}`, title: `Branch ${i}` })),
      },
      "msg_2",
    ) as { interactive: { type: string; action: { button: string; sections: { rows: unknown[] }[] } } };
    assert.equal(body.interactive.type, "list");
    assert.equal(body.interactive.action.button, "Branches");
    assert.equal(body.interactive.action.sections[0]?.rows.length, 5);
  });
});
