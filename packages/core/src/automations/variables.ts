/*
 * {{variables}} in step texts. No code runs: a variable is a dotted path into what the run knows,
 * with an optional fallback after "|" ({{contact.first_name|there}}). Anything missing becomes the
 * fallback, or nothing.
 *
 *   contact.name, contact.first_name, contact.phone, contact.email, contact.<custom field key>
 *   trigger.text        the message that started the run (never a later reply)
 *   answers.<name>      an answer saved by an "Ask a question" step
 *   chat.assignee       the assigned team member's name
 *   business.name       the business's name
 */

export type VariableScope = {
  contact: Record<string, unknown>;
  trigger: Record<string, unknown>;
  answers: Record<string, unknown>;
  chat: Record<string, unknown>;
  business: Record<string, unknown>;
};

const pattern = /\{\{\s*([a-zA-Z][\w]*(?:\.[\w-]+)*)\s*(?:\|([^}]*))?\}\}/g;

export const variableRoots = ["contact", "trigger", "answers", "chat", "business"] as const;

/** Every variable path a text uses, like ["contact.first_name", "answers.city"]. */
export function variablesUsed(text: string): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1] ?? "").filter(Boolean);
}

export function resolveText(text: string, scope: VariableScope): string {
  return text.replace(pattern, (_, path: string, fallback?: string) => {
    const value = lookup(scope, path);
    const s = value === null || value === undefined ? "" : String(value);
    return s.trim() ? s : (fallback?.trim() ?? "");
  });
}

function lookup(scope: VariableScope, path: string): unknown {
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
  return typeof value === "object" ? undefined : value;
}
