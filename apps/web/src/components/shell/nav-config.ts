// Icons: imported from lucide-react until the shared Icon component lands.
import { BarChart3, Bot, type LucideIcon, Megaphone, MessageCircle, Sparkles, Users } from "lucide-react";

/** The main sections of the app, in sidebar order, and the sub-topics shown in the sub-menu. */

export type SectionId = "today" | "conversations" | "customers" | "agents" | "campaigns" | "insights";

export type SubTopic = {
  label: string;
  /** Value of the `?view=` query on the section route. */
  view: string;
  href: string;
};

export type SubTopicGroup = { label: string; items: SubTopic[] };

export type Section = {
  id: SectionId;
  label: string;
  href: `/${SectionId}`;
  icon: LucideIcon;
  /** One sentence on what lives here. */
  summary: string;
  groups: SubTopicGroup[];
};

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function section(
  id: SectionId,
  label: string,
  icon: LucideIcon,
  summary: string,
  groups: { label: string; items: string[] }[],
): Section {
  const href = `/${id}` as const;
  return {
    id,
    label,
    href,
    icon,
    summary,
    groups: groups.map((g) => ({
      label: g.label,
      items: g.items.map((item) => ({ label: item, view: slug(item), href: `${href}?view=${slug(item)}` })),
    })),
  };
}

export const sections: Section[] = [
  section(
    "today",
    "Today",
    Sparkles,
    "What needs you today, what Mira is handling, and what is already done.",
    [
      { label: "Today", items: ["Everything", "Waiting for you", "Mira is handling", "Handled"] },
      { label: "Look back", items: ["Yesterday", "This week"] },
    ],
  ),
  section(
    "conversations",
    "Conversations",
    MessageCircle,
    "Every WhatsApp, Instagram and website chat in one inbox.",
    [
      { label: "Conversations", items: ["All open", "Needs a person", "Mira is handling", "Mine", "Closed"] },
      { label: "Channels", items: ["WhatsApp", "Instagram", "Website chat"] },
    ],
  ),
  section("customers", "Customers", Users, "Everyone who has talked to you, with their history and lists.", [
    { label: "People", items: ["Everyone", "New this week", "Booked", "Not seen in 6 months"] },
    { label: "Lists", items: ["VIP patients", "Whitening enquiries"] },
  ]),
  section("agents", "AI agent", Bot, "Teach Mira, try her out, put her live and improve her answers.", [
    { label: "Mira", items: ["Teach", "Try", "Go live", "Improve"] },
    { label: "Knowledge", items: ["Website", "Files", "Questions and answers"] },
  ]),
  section("campaigns", "Campaigns", Megaphone, "Messages you send to many customers at once.", [
    { label: "Campaigns", items: ["All", "Drafts", "Sending", "Sent"] },
    { label: "Messages", items: ["Approved messages", "Rejected"] },
  ]),
  section(
    "insights",
    "Insights",
    BarChart3,
    "Reports on conversations, the AI agent, campaigns and branches.",
    [
      { label: "Reports", items: ["Overview", "Conversations", "AI agent", "Campaigns"] },
      { label: "Compare", items: ["Branches", "This week and last"] },
    ],
  ),
];

export function getSection(id: SectionId): Section {
  const found = sections.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown section: ${id}`);
  return found;
}

/** The section a pathname belongs to, if any. */
export function sectionForPath(pathname: string): Section | undefined {
  return sections.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`));
}

/** The selected sub-topic. With no `?view=`, the first sub-topic is the default. */
export function currentSubTopic(s: Section, view: string | null | undefined): SubTopic | undefined {
  const all = s.groups.flatMap((g) => g.items);
  if (!view) return all[0];
  return all.find((t) => t.view === view);
}
