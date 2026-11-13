import type {
  TemplateButton,
  TemplateContent,
  TemplateDefinition,
  TemplatePurpose,
  TemplateStatus,
} from "@relay/core/templates";
import type { GraphClient } from "../meta/graph";
import type { OutboundMessage } from "../types";

/*
 * WhatsApp message templates. Relay's channel-agnostic template is translated to Meta's components
 * here and nowhere else. Templates belong to the WhatsApp Business Account (WABA), so every number
 * of one WABA shares them. Uses named parameters ({{customer_name}}), with an example for each.
 */

const categories: Record<TemplatePurpose, string> = {
  updates: "UTILITY",
  marketing: "MARKETING",
  login: "AUTHENTICATION",
};
const purposes: Record<string, TemplatePurpose> = {
  UTILITY: "updates",
  MARKETING: "marketing",
  AUTHENTICATION: "login",
};

/** Meta's template states, in Relay's words. */
export function whatsappTemplateStatus(status: string | undefined): TemplateStatus {
  switch ((status ?? "").toUpperCase()) {
    case "APPROVED":
      return "ready";
    case "REJECTED":
      return "needs_changes";
    case "PAUSED":
    case "FLAGGED":
      return "paused";
    case "DISABLED":
    case "DELETED":
    case "PENDING_DELETION":
    case "ARCHIVED":
      return "disabled";
    default:
      return "in_review"; // PENDING, IN_APPEAL, LIMIT_EXCEEDED…
  }
}

/** Meta's rejection codes, as advice a business owner can act on. */
const reasons: Record<string, string> = {
  INVALID_FORMAT: "Something in the message format isn't accepted. Check the details and buttons.",
  INCORRECT_CATEGORY: 'WhatsApp thinks the purpose is different. Try choosing "Offers and news".',
  ABUSIVE_CONTENT: "WhatsApp flagged the wording. Rephrase it in a neutral, helpful tone.",
  PROMOTIONAL: 'It reads like a promotion. Choose "Offers and news" or remove the offer.',
  TAG_CONTENT_MISMATCH: "The wording doesn't match the purpose you chose.",
  SCAM: "WhatsApp flagged it as possibly misleading. Make the sender and reason clear.",
  NONE: "",
};

export function whatsappReason(reason: string | null | undefined, extra?: string | null): string | null {
  if (!reason && !extra) return null;
  const known = reason ? reasons[reason.toUpperCase()] : undefined;
  if (known === "") return extra || null;
  return known ?? extra ?? reason?.toLowerCase().replace(/_/g, " ") ?? null;
}

const named = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const namesIn = (text: string) => [
  ...new Set([...text.matchAll(named)].map((m) => (m[1] ?? "").toLowerCase())),
];
/** Meta wants {{name}} with no spaces and lowercase names. */
const tidy = (text: string) => text.replace(named, (_w, n: string) => `{{${n.toLowerCase()}}}`);

function buttonComponent(b: TemplateButton) {
  if (b.kind === "reply") return { type: "QUICK_REPLY", text: b.text };
  if (b.kind === "link") return { type: "URL", text: b.text, url: b.url };
  return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone.replace(/[^\d+]/g, "") };
}

/**
 * Relay template → the body of POST /{waba}/message_templates.
 * `headerHandle` is the uploaded example for a picture, video or file header.
 */
export function buildWhatsAppTemplate(t: TemplateDefinition, headerHandle?: string | null) {
  const example = (n: string) => t.variables.find((v) => v.name === n)?.example ?? n;
  const components: Record<string, unknown>[] = [];
  const h = t.content.header;
  if (h?.kind === "text") {
    const vars = namesIn(h.text);
    components.push({
      type: "HEADER",
      format: "TEXT",
      text: tidy(h.text),
      ...(vars.length
        ? { example: { header_text_named_params: vars.map((n) => ({ param_name: n, example: example(n) })) } }
        : {}),
    });
  } else if (h) {
    components.push({
      type: "HEADER",
      format: h.kind.toUpperCase(),
      ...(headerHandle ? { example: { header_handle: [headerHandle] } } : {}),
    });
  }
  const bodyVars = namesIn(t.content.body);
  components.push({
    type: "BODY",
    text: tidy(t.content.body),
    ...(bodyVars.length
      ? { example: { body_text_named_params: bodyVars.map((n) => ({ param_name: n, example: example(n) })) } }
      : {}),
  });
  if (t.content.footer?.trim()) components.push({ type: "FOOTER", text: t.content.footer.trim() });
  if (t.content.buttons.length)
    components.push({ type: "BUTTONS", buttons: t.content.buttons.map(buttonComponent) });
  return {
    name: t.slug,
    language: t.language,
    category: categories[t.purpose],
    parameter_format: "named",
    components,
  };
}

type MetaComponent = {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; text?: string; url?: string; phone_number?: string }[];
  example?: { body_text_named_params?: { param_name: string; example: string }[] };
};

/** A template from Meta (made in WhatsApp Manager, or listed back) → Relay's shape. */
export function parseWhatsAppTemplate(t: {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  rejected_reason?: string;
  components?: MetaComponent[];
}): {
  externalId: string;
  definition: TemplateDefinition;
  status: TemplateStatus;
  reason: string | null;
} {
  const parts = t.components ?? [];
  const header = parts.find((c) => c.type === "HEADER");
  const body = parts.find((c) => c.type === "BODY");
  const footer = parts.find((c) => c.type === "FOOTER");
  const buttons = parts.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  // Older templates use numbered parameters ({{1}}); keep them working as details named "1", "2".
  const bodyText = body?.text ?? "";
  const content: TemplateContent = {
    header: !header
      ? null
      : header.format === "TEXT"
        ? { kind: "text", text: header.text ?? "" }
        : {
            kind: (header.format ?? "IMAGE").toLowerCase() as "image" | "video" | "document",
            attachmentId: null,
          },
    body: bodyText,
    footer: footer?.text ?? null,
    buttons: buttons.map(
      (b): TemplateButton =>
        b.type === "URL"
          ? { kind: "link", text: b.text ?? "", url: b.url ?? "" }
          : b.type === "PHONE_NUMBER"
            ? { kind: "call", text: b.text ?? "", phone: b.phone_number ?? "" }
            : { kind: "reply", text: b.text ?? "" },
    ),
  };
  const examples = body?.example?.body_text_named_params ?? [];
  const variables = namesIn(bodyText).map((name) => ({
    name,
    example: examples.find((e) => e.param_name === name)?.example ?? "",
  }));
  return {
    externalId: t.id ?? "",
    definition: {
      slug: t.name ?? "",
      language: t.language ?? "en",
      purpose: purposes[(t.category ?? "").toUpperCase()] ?? "updates",
      content,
      variables,
    },
    status: whatsappTemplateStatus(t.status),
    reason: whatsappReason(t.rejected_reason),
  };
}

/** The `template` object of a send call, with each detail's value. */
export function buildWhatsAppTemplateMessage(m: Extract<OutboundMessage, { type: "template" }>) {
  const components: Record<string, unknown>[] = [];
  if (m.headerMedia) {
    const { kind, providerMediaId, fileName } = m.headerMedia;
    components.push({
      type: "header",
      parameters: [
        {
          type: kind,
          [kind]: { id: providerMediaId, ...(kind === "document" && fileName ? { filename: fileName } : {}) },
        },
      ],
    });
  }
  const params = Object.entries(m.values).map(([name, value]) => ({
    type: "text",
    // Numbered parameters (old templates) are positional; named ones carry their name.
    ...(/^\d+$/.test(name) ? {} : { parameter_name: name }),
    text: value,
  }));
  if (params.length) components.push({ type: "body", parameters: params });
  return { name: m.name, language: { code: m.language }, ...(components.length ? { components } : {}) };
}

type Waba = { wabaId: string; accessToken: string };

export async function submitWhatsAppTemplate(
  graph: GraphClient,
  waba: Waba,
  t: TemplateDefinition,
  headerFile?: { bytes: Uint8Array; mimeType: string; fileName: string } | null,
) {
  const handle = headerFile ? await graph.resumableUpload(waba.accessToken, headerFile) : null;
  const res = await graph.request<{ id?: string; status?: string }>(
    "POST",
    `${waba.wabaId}/message_templates`,
    waba.accessToken,
    buildWhatsAppTemplate(t, handle),
  );
  if (!res.id) throw new Error("WhatsApp accepted the template but returned no id");
  return { externalId: res.id, status: whatsappTemplateStatus(res.status) };
}

/** Editing sends the new version for review. Only the content and purpose can change, not the name. */
export async function updateWhatsAppTemplate(
  graph: GraphClient,
  accessToken: string,
  templateId: string,
  t: TemplateDefinition,
  headerFile?: { bytes: Uint8Array; mimeType: string; fileName: string } | null,
) {
  const handle = headerFile ? await graph.resumableUpload(accessToken, headerFile) : null;
  const { category, components } = buildWhatsAppTemplate(t, handle);
  await graph.request("POST", templateId, accessToken, { category, components });
  return { status: "in_review" as TemplateStatus };
}

export async function deleteWhatsAppTemplate(
  graph: GraphClient,
  waba: Waba,
  templateId: string,
  slug: string,
) {
  const q = new URLSearchParams({ name: slug, hsm_id: templateId });
  await graph.request("DELETE", `${waba.wabaId}/message_templates?${q}`, waba.accessToken);
}

export async function listWhatsAppTemplates(graph: GraphClient, waba: Waba) {
  const out: ReturnType<typeof parseWhatsAppTemplate>[] = [];
  let path = `${waba.wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason,components&limit=100`;
  for (let page = 0; page < 20 && path; page++) {
    const res = await graph.request<{
      data?: Parameters<typeof parseWhatsAppTemplate>[0][];
      paging?: { next?: string; cursors?: { after?: string } };
    }>("GET", path, waba.accessToken);
    out.push(...(res.data ?? []).map(parseWhatsAppTemplate));
    const after = res.paging?.next ? res.paging.cursors?.after : undefined;
    path = after
      ? `${waba.wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason,components&limit=100&after=${after}`
      : "";
  }
  return out;
}
