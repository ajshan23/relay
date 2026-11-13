/*
 * Message templates, as Relay understands them: not tied to any channel.
 *
 * A template is a short message with details filled in when it is sent ("Hi {{customer_name}}, your
 * appointment is on {{date}}"). Channels that need approval (WhatsApp) review each one; channels that
 * don't (Instagram, Messenger) can use it straight away. Adapters translate this shape to their own.
 *
 * Pure code: safe in the browser, the API and the worker. Import from "@relay/core/templates".
 */

/** Why a business sends it, in plain words. Adapters map these to their own categories. */
export type TemplatePurpose = "updates" | "marketing" | "login";

export const templatePurposes: Record<TemplatePurpose, { label: string; hint: string }> = {
  updates: {
    label: "Updates and reminders",
    hint: "Appointments, bookings, orders, payments: things the customer is expecting.",
  },
  marketing: {
    label: "Offers and news",
    hint: "Promotions, new services, invitations to come back.",
  },
  login: {
    label: "Login codes",
    hint: "One-time codes to confirm it's really them.",
  },
};

export type TemplateHeader =
  | { kind: "text"; text: string }
  /** A picture, video or file shown above the message. The file is stored as a Relay attachment. */
  | { kind: "image" | "video" | "document"; attachmentId: string | null };

export type TemplateButton =
  /** A tap sends this text back as the customer's reply. */
  | { kind: "reply"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "call"; text: string; phone: string };

export type TemplateContent = {
  header: TemplateHeader | null;
  /** The message, with details written as {{name}}. */
  body: string;
  footer: string | null;
  buttons: TemplateButton[];
};

/** A detail filled in when sending, with an example the reviewer sees. */
export type TemplateVariable = { name: string; example: string };

/** What a channel needs to publish a template. */
export type TemplateDefinition = {
  /** Channel-safe name: lowercase letters, digits and underscores. */
  slug: string;
  language: string;
  purpose: TemplatePurpose;
  content: TemplateContent;
  variables: TemplateVariable[];
};

/** Where a template stands on one channel. */
export type TemplateStatus = "draft" | "in_review" | "ready" | "needs_changes" | "paused" | "disabled";

/** What a channel's templates can hold. Read by the editor and the API instead of checking the channel. */
export type TemplateLimits = {
  requiresApproval: boolean;
  /** Shown while a template is in review, e.g. "up to 2 hours". */
  reviewEstimate: string | null;
  purposes: TemplatePurpose[];
  headerKinds: TemplateHeader["kind"][];
  buttonKinds: TemplateButton["kind"][];
  maxButtons: number;
  maxBodyLength: number;
  maxHeaderTextLength: number;
  maxFooterLength: number;
  maxButtonTextLength: number;
  /** A plain-words note about editing published templates, or null when edits are free. */
  editNote: string | null;
};

/** Common details offered in the editor's "Add detail" menu, with a sensible example. */
export const commonDetails: { name: string; label: string; example: string }[] = [
  { name: "customer_name", label: "Customer name", example: "Sara" },
  { name: "date", label: "Date", example: "Saturday 16 November" },
  { name: "time", label: "Time", example: "10:30" },
  { name: "business_name", label: "Business name", example: "Lumen Clinics" },
  { name: "branch", label: "Branch", example: "Marina" },
  { name: "amount", label: "Amount", example: "AED 350" },
  { name: "order_number", label: "Order number", example: "#10482" },
  { name: "link", label: "Link", example: "https://example.com/b/8f2k" },
];

const variablePattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Details used in a piece of text, in order of first use. */
export function variablesIn(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(variablePattern)) {
    const name = (m[1] ?? "").toLowerCase();
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Every detail a template needs, from the header and body. */
export function templateVariables(content: TemplateContent): string[] {
  const header = content.header?.kind === "text" ? variablesIn(content.header.text) : [];
  return [...new Set([...header, ...variablesIn(content.body)])];
}

/** "Appointment reminder!" → "appointment_reminder". */
export function slugify(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return slug || "template";
}

/** The text with details filled in. Missing values stay as {{name}} so the gap is visible. */
export function fillVariables(text: string, values: Record<string, string>) {
  return text.replace(variablePattern, (whole, name: string) => {
    const v = values[name.toLowerCase()];
    return v?.trim() ? v : whole;
  });
}

export type TemplateIssue = {
  field: "name" | "header" | "body" | "footer" | "buttons" | "variables";
  message: string;
};

/** Problems that would stop a channel accepting the template, in plain words. Empty when it's fine. */
export function checkTemplate(
  t: { name: string; content: TemplateContent; variables: TemplateVariable[] },
  limits: TemplateLimits,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const { content } = t;
  if (!t.name.trim()) issues.push({ field: "name", message: "Give the template a name." });

  const body = content.body.trim();
  if (!body) issues.push({ field: "body", message: "Write the message." });
  if (body.length > limits.maxBodyLength)
    issues.push({ field: "body", message: `Keep the message under ${limits.maxBodyLength} characters.` });
  if (/^\{\{[^}]+\}\}/.test(body) || /\{\{[^}]+\}\}[.!?]?$/.test(body))
    issues.push({ field: "body", message: "A detail can't be the very first or last thing in the message." });
  if (/\}\}\s*\{\{/.test(body))
    issues.push({ field: "body", message: "Put some words between two details." });
  if (/\{\{(?![a-zA-Z0-9_ ]+\}\})/.test(body) || /\{\{\s*\}\}/.test(body))
    issues.push({ field: "body", message: "A detail looks broken. Use the Add detail menu to insert it." });

  const vars = templateVariables(content);
  if (body && vars.length > 0) {
    const words = body.replace(variablePattern, "").trim().split(/\s+/).filter(Boolean).length;
    if (words < vars.length * 2 + 1)
      issues.push({
        field: "body",
        message:
          "Add a few more words around the details; reviewers reject messages that are mostly details.",
      });
  }
  for (const name of vars) {
    const v = t.variables.find((x) => x.name === name);
    if (!v?.example.trim())
      issues.push({ field: "variables", message: `Add an example for "${name.replace(/_/g, " ")}".` });
  }

  if (content.header) {
    if (!limits.headerKinds.includes(content.header.kind))
      issues.push({ field: "header", message: "This channel doesn't support that kind of header." });
    if (content.header.kind === "text") {
      if (!content.header.text.trim())
        issues.push({ field: "header", message: "Write the header, or remove it." });
      if (content.header.text.length > limits.maxHeaderTextLength)
        issues.push({
          field: "header",
          message: `Keep the header under ${limits.maxHeaderTextLength} characters.`,
        });
    } else if (!content.header.attachmentId) {
      issues.push({
        field: "header",
        message: `Add the ${content.header.kind} for the header, or remove it.`,
      });
    }
  }
  if (content.footer && content.footer.length > limits.maxFooterLength)
    issues.push({ field: "footer", message: `Keep the footer under ${limits.maxFooterLength} characters.` });
  if (content.footer && variablesIn(content.footer).length)
    issues.push({ field: "footer", message: "The footer can't contain details." });

  if (content.buttons.length > limits.maxButtons)
    issues.push({ field: "buttons", message: `Use at most ${limits.maxButtons} buttons.` });
  for (const b of content.buttons) {
    if (!limits.buttonKinds.includes(b.kind))
      issues.push({ field: "buttons", message: "This channel doesn't support that kind of button." });
    if (!b.text.trim()) issues.push({ field: "buttons", message: "Every button needs a label." });
    if (b.text.length > limits.maxButtonTextLength)
      issues.push({
        field: "buttons",
        message: `Keep button labels under ${limits.maxButtonTextLength} characters.`,
      });
    if (b.kind === "link" && !/^https?:\/\/\S+\.\S+/.test(b.url))
      issues.push({ field: "buttons", message: "Link buttons need a full web address (https://…)." });
    if (b.kind === "call" && !/^\+?[0-9 ()-]{7,20}$/.test(b.phone))
      issues.push({ field: "buttons", message: "Call buttons need a phone number with country code." });
  }
  return issues;
}
