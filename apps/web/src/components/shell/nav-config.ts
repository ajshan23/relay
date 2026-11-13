// Icons: imported from lucide-react until the shared Icon component lands.
import { BarChart3, Bot, type LucideIcon, Megaphone, MessageCircle, Sparkles, Users } from "lucide-react";

/** The main sections of the app, in sidebar order, and the sub-topics shown in the sub-menu. */

export type SectionId = "today" | "conversations" | "contacts" | "agents" | "broadcasts" | "insights";

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
  groups: { label: string; items: (string | { label: string; view: string })[] }[],
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
      items: g.items.map((item) => {
        const { label: text, view } = typeof item === "string" ? { label: item, view: slug(item) } : item;
        return { label: text, view, href: `${href}?view=${view}` };
      }),
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
      // The inbox's own sub-menu (inbox-nav.tsx) adds live counts and the business's channels.
      {
        label: "Conversations",
        items: [
          { label: "Open", view: "open" },
          { label: "Assigned to me", view: "mine" },
          { label: "Unassigned", view: "unassigned" },
          { label: "Closed", view: "closed" },
        ],
      },
    ],
  ),
  section(
    "contacts",
    "Contacts",
    Users,
    "Everyone who has talked to you, with their details, tags and lists.",
    [
      {
        label: "Contacts",
        items: [
          { label: "All contacts", view: "all" },
          { label: "New this week", view: "new" },
          { label: "Opted out", view: "opted-out" },
        ],
      },
    ],
  ),
  section("agents", "AI agent", Bot, "Teach Mira, try her out, put her live and improve her answers.", [
    { label: "Mira", items: ["Teach", "Try", "Go live", "Improve"] },
    { label: "Knowledge", items: ["Website", "Files", "Questions and answers"] },
  ]),
  section("broadcasts", "Broadcasts", Megaphone, "Messages you send to many contacts at once.", [
    { label: "Broadcasts", items: ["All", "Drafts", "Scheduled", "Sent"] },
  ]),
  section(
    "insights",
    "Insights",
    BarChart3,
    "Reports on conversations, the AI agent, broadcasts and branches.",
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
