/**
 * Who runs Relay, as shown on the landing page and in the legal pages.
 * The operator, email and country are placeholders until the business details are confirmed.
 */
export const site = {
  name: "Relay",
  operator: "Relay",
  email: "support@relay.test",
  country: "India",
  updated: "14 November 2026",
} as const;

export const nav = [
  { href: "/#inbox", label: "Inbox" },
  { href: "/#agent", label: "AI agent" },
  { href: "/#campaigns", label: "Campaigns" },
  { href: "/#how", label: "How it works" },
  { href: "/#faq", label: "FAQ" },
] as const;
