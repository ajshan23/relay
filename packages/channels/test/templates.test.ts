import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { templateLibrary } from "@relay/core/template-library";
import { checkTemplate, slugify, type TemplateDefinition } from "@relay/core/templates";
import { whatsappCapabilities } from "../src/whatsapp/capabilities";
import { parseWhatsAppWebhook } from "../src/whatsapp/parse";
import { buildWhatsAppSendBody } from "../src/whatsapp/send";
import { buildWhatsAppTemplate, parseWhatsAppTemplate } from "../src/whatsapp/templates";
import { WABA } from "./fixtures";

const reminder: TemplateDefinition = {
  slug: "appointment_reminder",
  language: "en",
  purpose: "updates",
  content: {
    header: { kind: "text", text: "Appointment reminder" },
    body: "Hi {{customer_name}}, your visit is on {{ date }} at our clinic. Reply to confirm.",
    footer: "Reply STOP to stop reminders",
    buttons: [
      { kind: "reply", text: "Confirm" },
      { kind: "link", text: "Directions", url: "https://maps.example.com" },
      { kind: "call", text: "Call us", phone: "+971 4 123 4567" },
    ],
  },
  variables: [
    { name: "customer_name", example: "Sara" },
    { name: "date", example: "Saturday" },
  ],
};

describe("WhatsApp templates", () => {
  it("builds Meta's create body with named parameters and examples", () => {
    const body = buildWhatsAppTemplate(reminder) as {
      category: string;
      parameter_format: string;
      components: Record<string, unknown>[];
    };
    assert.equal(body.category, "UTILITY");
    assert.equal(body.parameter_format, "named");
    const [header, main, footer, buttons] = body.components;
    assert.deepEqual(header, { type: "HEADER", format: "TEXT", text: "Appointment reminder" });
    assert.equal(
      main?.text,
      "Hi {{customer_name}}, your visit is on {{date}} at our clinic. Reply to confirm.",
    );
    assert.deepEqual(
      (main?.example as { body_text_named_params: unknown[] } | undefined)?.body_text_named_params,
      [
        { param_name: "customer_name", example: "Sara" },
        { param_name: "date", example: "Saturday" },
      ],
    );
    assert.equal(footer?.text, "Reply STOP to stop reminders");
    assert.deepEqual(buttons?.buttons, [
      { type: "QUICK_REPLY", text: "Confirm" },
      { type: "URL", text: "Directions", url: "https://maps.example.com" },
      { type: "PHONE_NUMBER", text: "Call us", phone_number: "+97141234567" },
    ]);
  });

  it("uses an uploaded handle for a picture header", () => {
    const body = buildWhatsAppTemplate(
      { ...reminder, content: { ...reminder.content, header: { kind: "image", attachmentId: "att_1" } } },
      "4::aGVsbG8=",
    ) as { components: Record<string, unknown>[] };
    assert.deepEqual(body.components[0], {
      type: "HEADER",
      format: "IMAGE",
      example: { header_handle: ["4::aGVsbG8="] },
    });
  });

  it("reads a template made in WhatsApp Manager back into Relay's shape", () => {
    const parsed = parseWhatsAppTemplate({
      id: "991",
      name: "hello_world",
      language: "en_US",
      status: "APPROVED",
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Hello World" },
        { type: "BODY", text: "Welcome and congratulations!!" },
        { type: "FOOTER", text: "WhatsApp Business Platform sample message" },
      ],
    });
    assert.equal(parsed.status, "ready");
    assert.equal(parsed.definition.slug, "hello_world");
    assert.equal(parsed.definition.purpose, "updates");
    assert.deepEqual(parsed.definition.content.header, { kind: "text", text: "Hello World" });
  });

  it("turns the review webhook into a channel-agnostic event with a plain reason", () => {
    const events = parseWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "message_template_status_update",
              value: {
                event: "REJECTED",
                message_template_id: 1234567,
                message_template_name: "spring_sale",
                message_template_language: "en",
                reason: "INCORRECT_CATEGORY",
              },
            },
          ],
        },
      ],
    });
    assert.equal(events.length, 1);
    const e = events[0] as { kind: string; templateExternalId: string; status: string; reason: string };
    assert.equal(e.kind, "template.status_changed");
    assert.equal(e.templateExternalId, "1234567");
    assert.equal(e.status, "needs_changes");
    assert.match(e.reason, /Offers and news/);
  });

  it("sends a template with named values and a picture header", () => {
    const body = buildWhatsAppSendBody(
      { kind: "direct", phone: "15550001111", userId: null },
      {
        type: "template",
        name: "appointment_reminder",
        language: "en",
        values: { customer_name: "Sara", date: "Saturday" },
        headerMedia: { kind: "image", providerMediaId: "media.1" },
      },
      "msg_1",
    );
    assert.equal(body.type, "template");
    assert.deepEqual(body.template, {
      name: "appointment_reminder",
      language: { code: "en" },
      components: [
        { type: "header", parameters: [{ type: "image", image: { id: "media.1" } }] },
        {
          type: "body",
          parameters: [
            { type: "text", parameter_name: "customer_name", text: "Sara" },
            { type: "text", parameter_name: "date", text: "Saturday" },
          ],
        },
      ],
    });
  });
});

describe("Template rules", () => {
  const limits = whatsappCapabilities.templates;
  if (!limits) throw new Error("WhatsApp must support templates");

  it("accepts every ready-made library template", () => {
    for (const t of templateLibrary) {
      assert.deepEqual(
        checkTemplate({ name: t.name, content: t.content, variables: t.variables }, limits),
        [],
        t.key,
      );
    }
  });

  it("explains common mistakes in plain words", () => {
    const issues = checkTemplate(
      {
        name: "x",
        content: {
          header: null,
          body: "{{name}} {{date}}",
          footer: null,
          buttons: [{ kind: "link", text: "Go", url: "example" }],
        },
        variables: [{ name: "name", example: "" }],
      },
      limits,
    ).map((i) => i.message);
    assert.ok(issues.some((m) => m.includes("first or last")));
    assert.ok(issues.some((m) => m.includes("between two details")));
    assert.ok(issues.some((m) => m.includes('example for "name"')));
    assert.ok(issues.some((m) => m.includes("full web address")));
  });

  it("makes channel-safe names", () => {
    assert.equal(slugify("Appointment reminder!"), "appointment_reminder");
    assert.equal(slugify("Café — offre spéciale"), "cafe_offre_speciale");
  });
});
