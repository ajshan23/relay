/*
 * {{variables}} in step texts. No code runs: a variable is a dotted path into what the run knows,
 * with an optional fallback after "|" ({{contact.first_name|there}}). Anything missing becomes the
 * fallback, or nothing.
 *
 *   contact.name, contact.first_name, contact.phone, contact.email, contact.<custom field key>
 *   trigger.text        the message that started the run (never a later reply)
 *   answers.<name>      an answer saved by an "Ask a question" step
 *   answers.<name>.map_link (.latitude .longitude .name .address)  a location shared with "Ask for location"
 *   values.<name>       what a Utility step worked out (values.dist reads "4.2 km"; values.dist.km is 4.2)
 *   chat.assignee       the assigned team member's name
 *   business.name       the business's name
 */

export type VariableScope = {
  contact: Record<string, unknown>;
  trigger: Record<string, unknown>;
  answers: Record<string, unknown>;
  /** Utility results; empty before any ran. */
  values?: Record<string, unknown>;
  chat: Record<string, unknown>;
  business: Record<string, unknown>;
};

const pattern = /\{\{\s*([a-zA-Z][\w]*(?:\.[\w-]+)*)\s*(?:\|([^}]*))?\}\}/g;

export const variableRoots = ["contact", "trigger", "answers", "values", "chat", "business"] as const;

/** Every variable path a text uses, like ["contact.first_name", "answers.city"]. */
export function variablesUsed(text: string): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1] ?? "").filter(Boolean);
}

/**
 * Fills a text's variables. `encode` is applied to each filled value (not to fallbacks), e.g.
 * encodeURIComponent for a link, so a value can't break out of its place in the URL.
 */
export function resolveText(text: string, scope: VariableScope, encode?: (value: string) => string): string {
  return text.replace(pattern, (_, path: string, fallback?: string) => {
    const value = lookup(scope, path);
    const s = value === null || value === undefined ? "" : String(value);
    if (s.trim()) return encode ? encode(s) : s;
    return fallback?.trim() ?? "";
  });
}

/** A saved value as stored: a shared location or a utility's result stays an object. */
export function lookupRaw(scope: VariableScope, path: string): unknown {
  const [root, ...rest] = path.split(".");
  if (!root || !(variableRoots as readonly string[]).includes(root)) return undefined;
  let value: unknown = (scope as Record<string, unknown>)[root];
  for (const key of rest) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  if (root === "contact" && rest[0] === "first_name" && value === undefined) {
    const name = String(scope.contact.name ?? "").trim();
    return name ? name.split(/\s+/)[0] : undefined;
  }
  return value;
}

/** A saved value as text: {{answers.pickup}} and {{values.dist}} read as their text. */
export function lookupText(scope: VariableScope, path: string): string {
  const v = lookup(scope, path);
  return v === null || v === undefined ? "" : String(v);
}

function lookup(scope: VariableScope, path: string): unknown {
  const value = lookupRaw(scope, path);
  // A value with parts (a shared location, a utility's result) reads as its text: {{answers.pickup}}.
  if (value !== null && typeof value === "object") {
    const text = (value as { text?: unknown }).text;
    return typeof text === "string" ? text : undefined;
  }
  return value;
}
