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

describe("WhatsApp link buttons and locations", () => {
  const to = { kind: "direct" as const, phone: "919847000101", userId: null };
  it("sends a map pin", () => {
    const body = buildWhatsAppSendBody(
      to,
      { type: "location", latitude: 25.08, longitude: 55.14, name: "Lumen Marina", address: "Dubai Marina" },
      "m1",
    );
    assert.equal(body.type, "location");
    assert.deepEqual(body.location, {
      latitude: 25.08,
      longitude: 55.14,
      name: "Lumen Marina",
      address: "Dubai Marina",
    });
  });
  it("leaves out an empty name and address", () => {
    const body = buildWhatsAppSendBody(to, { type: "location", latitude: 1, longitude: 2 }, "m2");
    assert.deepEqual(body.location, { latitude: 1, longitude: 2 });
  });
  it("builds a link button, with a picture on top and the button text cut to 20", () => {
    const body = buildWhatsAppSendBody(
      to,
      {
        type: "interactive",
        kind: "cta_url",
        body: "Pick a time that suits you",
        button: { text: "Book your visit right now", url: "https://example.com/l/abc" },
        headerMedia: { kind: "image", providerMediaId: "IMG1" },
        footer: "Lumen Clinics",
      },
      "m3",
    );
    assert.equal(body.type, "interactive");
    assert.deepEqual(body.interactive, {
      type: "cta_url",
      header: { type: "image", image: { id: "IMG1" } },
      body: { text: "Pick a time that suits you" },
      footer: { text: "Lumen Clinics" },
      action: {
        name: "cta_url",
        parameters: { display_text: "Book your visit rig…", url: "https://example.com/l/abc" },
      },
    });
  });
  it("builds an item card: reply buttons with the main photo on top", () => {
    const body = buildWhatsAppSendBody(
      to,
      {
        type: "interactive",
        kind: "buttons",
        body: "*Sofa Oslo*\nAED 1,800",
        options: [
          { id: "qa_i0m", title: "More details" },
          { id: "qa_i0o", title: "Order" },
        ],
        headerMedia: { kind: "image", providerMediaId: "IMG2" },
      },
      "m5",
    );
    assert.deepEqual(body.interactive, {
      type: "button",
      header: { type: "image", image: { id: "IMG2" } },
      body: { text: "*Sofa Oslo*\nAED 1,800" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "qa_i0m", title: "More details" } },
          { type: "reply", reply: { id: "qa_i0o", title: "Order" } },
        ],
      },
    });
  });
  it("builds a carousel of cards with linked pictures and the same buttons on each", () => {
    const card = (n: number) => ({
      media: { kind: "image" as const, link: `https://files.example/${n}.jpg` },
      body: `Item ${n}\n${"x".repeat(200)}`,
      buttons: [
        { id: `q_i${n}m`, title: "More details" },
        { id: `q_i${n}o`, title: "Order" },
        { id: "extra", title: "Ignored third" },
      ],
    });
    const body = buildWhatsAppSendBody(
      to,
      { type: "interactive", kind: "carousel", body: "Two picks", cards: [card(0), card(1)] },
      "m6",
    );
    const i = body.interactive as {
      type: string;
      body: { text: string };
      action: { cards: Record<string, unknown>[] };
    };
    assert.equal(i.type, "carousel");
    assert.deepEqual(i.body, { text: "Two picks" });
    assert.equal(i.action.cards.length, 2);
    const first = i.action.cards[0] as {
      card_index: number;
      header: unknown;
      body: { text: string };
      action: { buttons: { quick_reply: { id: string } }[] };
    };
    assert.equal(first.card_index, 0);
    assert.deepEqual(first.header, { type: "image", image: { link: "https://files.example/0.jpg" } });
    assert.equal(first.body.text.length, 160, "card text is cut to 160");
    assert.deepEqual(
      first.action.buttons.map((b) => b.quick_reply.id),
      ["q_i0m", "q_i0o"],
    );
  });
  it("asks for the customer's location", () => {
    const body = buildWhatsAppSendBody(
      to,
      { type: "interactive", kind: "location_request", body: "Where should we pick you up?" },
      "m4",
    );
    assert.deepEqual(body.interactive, {
      type: "location_request_message",
      body: { text: "Where should we pick you up?" },
      action: { name: "send_location" },
    });
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

describe("template quick-reply payloads", () => {
  it("sends our payload for each quick-reply button by position", () => {
    const body = buildWhatsAppSendBody(
      { kind: "direct", phone: "919847000000", userId: null },
      {
        type: "template",
        name: "follow_up",
        language: "en",
        values: { name: "Asha" },
        quickReplyPayloads: [
          { index: 0, payload: "qabc_0" },
          { index: 1, payload: "qabc_1" },
        ],
      },
      "msg_3",
    ) as {
      template: { components: { type: string; sub_type?: string; index?: string; parameters: unknown[] }[] };
    };
    const buttons = body.template.components.filter((c) => c.type === "button");
    assert.deepEqual(
      buttons.map((b) => [b.sub_type, b.index, b.parameters]),
      [
        ["quick_reply", "0", [{ type: "payload", payload: "qabc_0" }]],
        ["quick_reply", "1", [{ type: "payload", payload: "qabc_1" }]],
      ],
    );
  });
});
