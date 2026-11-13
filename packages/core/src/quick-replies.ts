/*
 * Quick reply placeholders, filled in when an agent inserts a reply. Browser-safe: import from
 * "@relay/core/quick-replies". A placeholder with no value stays as written ({first_name}), so the
 * agent sees it and fills it in by hand.
 */

export const quickReplyPlaceholders = [
  { key: "first_name", label: "Customer's first name" },
  { key: "name", label: "Customer's name" },
  { key: "agent_name", label: "Your name" },
  { key: "business_name", label: "Business name" },
] as const;

export type QuickReplyValues = Partial<Record<(typeof quickReplyPlaceholders)[number]["key"], string | null>>;

export function fillQuickReply(body: string, values: QuickReplyValues) {
  return body.replace(
    /\{(first_name|name|agent_name|business_name)\}/g,
    (whole, key: keyof QuickReplyValues) => {
      const v = values[key]?.trim();
      return v ? v : whole;
    },
  );
}
