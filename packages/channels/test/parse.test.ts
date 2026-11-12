import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWhatsAppWebhook } from "../src/whatsapp/parse";
import {
  CUSTOMER,
  CUSTOMER_BSUID,
  contacts,
  envelope,
  incoming,
  messages,
  PHONE_ID,
  status,
  WABA,
} from "./fixtures";

// biome-ignore lint/suspicious/noExplicitAny: tests reach into whichever event variant came back
type Loose = Record<string, any>;

const one = (payload: unknown) => {
  const events = parseWhatsAppWebhook(payload);
  assert.equal(events.length, 1);
  return events[0] as never as Loose;
};

describe("WhatsApp webhook parser", () => {
  it("ignores payloads from other Meta products", () => {
    assert.deepEqual(parseWhatsAppWebhook({ object: "page", entry: [] }), []);
    assert.deepEqual(parseWhatsAppWebhook(null), []);
  });

  it("routes by phone number id and identifies the sender by BSUID, keeping the phone", () => {
    const e = one(incoming(messages.text as never));
    assert.equal(e.kind, "message.received");
    assert.equal(e.accountExternalId, PHONE_ID);
    assert.deepEqual(e.from, {
      externalId: CUSTOMER_BSUID,
      scope: WABA,
      phone: CUSTOMER,
      username: null,
      profileName: "Hana Test",
    });
    assert.deepEqual(e.content, { type: "text", text: "Hi, can I book a cleaning?" });
    assert.equal(e.sentAt.toISOString(), new Date(1789380000 * 1000).toISOString());
  });

  it("falls back to the phone number when there is no BSUID", () => {
    const payload = envelope({
      contacts: [{ profile: { name: "Old" }, wa_id: CUSTOMER }],
      messages: [{ from: CUSTOMER, id: "wamid.x", timestamp: "1", type: "text", text: { body: "hi" } }],
    });
    assert.equal(one(payload).from.externalId, CUSTOMER);
  });

  it("handles username users whose phone is hidden", () => {
    const payload = envelope({
      contacts: [{ profile: { name: "U", username: "hana.t" }, user_id: CUSTOMER_BSUID }],
      messages: [
        { from_user_id: CUSTOMER_BSUID, id: "wamid.u", timestamp: "1", type: "text", text: { body: "hi" } },
      ],
    });
    const e = one(payload);
    assert.equal(e.from.externalId, CUSTOMER_BSUID);
    assert.equal(e.from.phone, null);
    assert.equal(e.from.username, "hana.t");
  });

  it("parses every message type", () => {
    const expect: Record<string, (c: Loose) => void> = {
      image: (c) =>
        assert.deepEqual(
          [c.type, c.media.providerMediaId, c.media.caption],
          ["image", "MEDIA_1", "my x-ray"],
        ),
      video: (c) => assert.equal(c.media.mimeType, "video/mp4"),
      audio: (c) => assert.equal(c.voice, true),
      document: (c) => assert.deepEqual([c.media.fileName, c.media.caption], ["invoice.pdf", "here"]),
      sticker: (c) => assert.equal(c.animated, true),
      location: (c) => assert.deepEqual([c.latitude, c.name, c.url], [25.08, "Marina", null]),
      contacts: (c) => assert.equal(c.contacts.length, 1),
      button: (c) => assert.deepEqual([c.payload, c.text], ["ACTION_CONFIRM", "Confirm"]),
      button_reply: (c) => assert.deepEqual([c.kind, c.id, c.title], ["button_reply", "confirm", "Confirm"]),
      list_reply: (c) => assert.equal(c.description, "Send to my address"),
      nfm_reply: (c) => assert.deepEqual([c.kind, c.response.delivery], ["flow_reply", "home"]),
      order: (c) =>
        assert.deepEqual(c.items[0], { productId: "SKU1", quantity: 2, price: 7.99, currency: "AED" }),
      unsupported: (c) => assert.deepEqual(c, { type: "unsupported", reason: "edit" }),
    };
    for (const [name, check] of Object.entries(expect)) {
      const e = one(incoming(messages[name] as never));
      check(e.content);
    }
  });

  it("keeps message errors, reply context and ad referrals", () => {
    const e = one(
      incoming({
        ...(messages.text as object),
        context: { id: "wamid.prev", forwarded: true },
        referral: { source_id: "AD1", ctwa_clid: "C1" },
      } as never),
    );
    assert.equal(e.context.replyToExternalId, "wamid.prev");
    assert.equal(e.context.forwarded, true);
    assert.equal((e.context.adReferral as Record<string, string>).ctwa_clid, "C1");
    const u = one(incoming(messages.unsupported as never));
    assert.equal(u.errors[0].code, 131051);
  });

  it("does not crash on a bad Flow response", () => {
    const e = one(
      incoming({
        type: "interactive",
        interactive: { type: "nfm_reply", nfm_reply: { name: "f", response_json: "{oops" } },
      } as never),
    );
    assert.equal(e.content.response, null);
    assert.equal(e.content.responseRaw, "{oops");
  });

  it("turns reactions into reaction events, including removals", () => {
    const added = one(
      incoming({ type: "reaction", reaction: { message_id: "wamid.out1", emoji: "👍" } } as never),
    );
    assert.deepEqual([added.kind, added.targetExternalId, added.emoji], ["reaction", "wamid.out1", "👍"]);
    const removed = one(incoming({ type: "reaction", reaction: { message_id: "wamid.out1" } } as never));
    assert.equal(removed.emoji, null);
  });

  it("turns number and id changes into contact.changed", () => {
    const e = one(
      envelope({
        messages: [
          {
            from: CUSTOMER,
            id: "wamid.sys",
            timestamp: "1",
            type: "system",
            system: {
              type: "user_changed_user_id",
              body: "changed",
              user_id: "US.NEW",
              previous_user_id: CUSTOMER_BSUID,
            },
          },
        ],
      }),
    );
    assert.deepEqual(
      [e.kind, e.previousExternalId, e.newExternalId],
      ["contact.changed", CUSTOMER_BSUID, "US.NEW"],
    );
  });

  it("parses statuses with our callback id, pricing and errors", () => {
    const sent = one(
      status({
        status: "delivered",
        biz_opaque_callback_data: "msg_1",
        pricing: { category: "service", type: "free_customer_service" },
      }),
    );
    assert.deepEqual(
      [sent.kind, sent.status, sent.ourMessageId, sent.recipientExternalId],
      ["message.status", "delivered", "msg_1", CUSTOMER_BSUID],
    );
    assert.equal(sent.pricing.category, "service");
    const failed = one(
      status({
        status: "failed",
        errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "window" } }],
      }),
    );
    assert.deepEqual([failed.errors[0].code, failed.errors[0].details], [131047, "window"]);
  });

  it("iterates every entry, change, message and status", () => {
    const a = incoming(messages.text as never);
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        { id: WABA, changes: [a.entry[0]?.changes[0], status({ status: "read" }).entry[0]?.changes[0]] },
        { id: WABA, changes: [incoming(messages.image as never).entry[0]?.changes[0]] },
      ],
    };
    assert.deepEqual(
      parseWhatsAppWebhook(payload).map((e) => e.kind),
      ["message.received", "message.status", "message.received"],
    );
  });

  it("reports other webhook fields and top-level errors as account updates", () => {
    const q = one(envelope({ event: "FLAGGED", current_limit: "TIER_1K" }, "phone_number_quality_update"));
    assert.deepEqual([q.kind, q.field], ["account.update", "phone_number_quality_update"]);
    const err = one(envelope({ errors: [{ code: 131000, title: "Something went wrong" }] }));
    assert.deepEqual([err.field, err.errors[0].code], ["errors", 131000]);
  });

  it("skips messages with no identifiable sender instead of inventing one", () => {
    const payload = envelope({
      messages: [{ id: "wamid.n", timestamp: "1", type: "text", text: { body: "x" } }],
      contacts: [],
    });
    assert.deepEqual(parseWhatsAppWebhook(payload), []);
    assert.ok(contacts.length);
  });
});
