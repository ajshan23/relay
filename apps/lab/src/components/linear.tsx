"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  CircleDashed,
  CircleHelp,
  History,
  ListFilter,
  MessagesSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Upload,
  UserPlus,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ChannelTag, CompactContext, LiveDot, Person } from "@/components/bits";
import { AssistantThread } from "@/components/homes";
import { AgentsPage, CampaignsPage, ChatThread, CustomersPage, InsightsPage } from "@/components/pages";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { branches, handledToday, type PageId, pages, recents } from "@/lib/data";
import { useLab } from "@/lib/store";
import type { SidebarId } from "@/lib/themes";
import { cn } from "@/lib/utils";

/*
 * A structure in the manner of Linear: a quiet sidebar on the canvas, one inset sheet,
 * a thin header with view tabs, dense rows instead of cards, and a status bar.
 * The colours come from whichever colour design is selected.
 */

const title: Record<PageId, string> = {
  home: "My work",
  inbox: "Conversations",
  customers: "Customers",
  agents: "AI agent",
  campaigns: "Campaigns",
  insights: "Insights",
};

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Pills<T extends string>({
  items,
  value,
  onChange,
}: {
  items: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1.5 px-3 py-2" role="tablist">
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={value === item}
          onClick={() => onChange(item)}
          className={cn(
            "h-7 rounded-full border px-3 text-[13px]",
            value === item
              ? "border-transparent bg-muted font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:bg-muted/60",
          )}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- My work */

const workTabs = ["Today", "Needs you", "Mira", "Handled"] as const;

function Group({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-9 w-full items-center gap-2 bg-muted/60 px-4 text-[13px] font-medium"
      >
        <Chevron className="size-3.5 text-muted-foreground" />
        {label}
        <span className="font-normal text-muted-foreground">{count}</span>
      </button>
      {open ? <ul>{children}</ul> : null}
    </section>
  );
}

function Row({
  icon,
  text,
  meta,
  onClick,
}: {
  icon: ReactNode;
  text: ReactNode;
  meta: ReactNode;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex h-10 w-full items-center gap-3 border-b px-4 text-left text-[13px] hover:bg-muted/50"
      >
        <span className="flex w-4 shrink-0 justify-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">{meta}</span>
      </button>
    </li>
  );
}

function WorkList() {
  const { needs, chats, go, openChat, notify } = useLab();
  const [tab, setTab] = useState<(typeof workTabs)[number]>("Today");
  const live = chats.filter((c) => c.who === "Mira");
  const show = (group: (typeof workTabs)[number]) => tab === "Today" || tab === group;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Pills items={workTabs} value={tab} onChange={setTab} />
      <div className="scroll-thin flex-1 overflow-y-auto border-t">
        {show("Needs you") ? (
          <Group label="Needs you" count={needs.length}>
            {needs.map((n) => (
              <Row
                key={n.id}
                icon={<CircleAlert className="size-4 text-destructive" />}
                text={
                  <>
                    <span className="font-medium">{n.title}</span>
                    <span className="ml-2 text-muted-foreground">{n.detail}</span>
                  </>
                }
                meta={<span className="font-medium text-foreground">{n.action}</span>}
                onClick={() => go(n.go)}
              />
            ))}
          </Group>
        ) : null}
        {show("Mira") ? (
          <Group label="Mira is handling" count={live.length}>
            {live.map((c) => (
              <Row
                key={c.id}
                icon={<CircleDashed className="size-4 text-ai-strong" />}
                text={
                  <>
                    <span className="font-medium">{c.name}</span>
                    <span className="ml-2 text-muted-foreground">{c.lines.at(-1)?.text}</span>
                  </>
                }
                meta={
                  <>
                    <ChannelTag channel={c.channel} />
                    <span className="w-10 text-right tabular-nums">{c.time}</span>
                  </>
                }
                onClick={() => {
                  openChat(c.id);
                  go("inbox");
                }}
              />
            ))}
          </Group>
        ) : null}
        {show("Handled") ? (
          <Group label="Handled today" count={42}>
            {handledToday.map((h) => (
              <Row
                key={h.name}
                icon={<CheckCircle2 className="size-4 text-good" />}
                text={
                  <>
                    <span className="font-medium">{h.name}</span>
                    <span className="ml-2 text-muted-foreground">{h.detail}</span>
                  </>
                }
                meta={
                  <>
                    <span>{h.outcome}</span>
                    <span className="w-10 text-right tabular-nums">{h.time}</span>
                  </>
                }
                onClick={() => notify(`${h.name}: ${h.outcome.toLowerCase()}`)}
              />
            ))}
          </Group>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- Conversations */

const chatTabs = ["All", "Needs a person", "Mira", "Mine"] as const;

function Conversations() {
  const { chats, chatId, openChat } = useLab();
  const [tab, setTab] = useState<(typeof chatTabs)[number]>("All");
  const list = chats.filter((c) => tab === "All" || c.who === tab || (tab === "Mine" && c.who === "Priya"));
  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label="Conversations" className="flex w-full shrink-0 flex-col border-r md:w-[340px]">
        <Pills items={chatTabs} value={tab} onChange={setTab} />
        <ul className="scroll-thin flex-1 overflow-y-auto border-t">
          {list.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                aria-current={c.id === chatId}
                onClick={() => openChat(c.id)}
                className={cn(
                  "flex w-full items-start gap-3 border-b px-4 py-2.5 text-left text-[13px]",
                  c.id === chatId ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <Person name={c.name} className="mt-0.5 size-7" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate", c.unread ? "font-semibold" : "font-medium")}>
                      {c.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.time}</span>
                  </span>
                  <span className="block truncate text-muted-foreground">{c.preview}</span>
                </span>
                {c.who === "Needs a person" ? (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-destructive" />
                ) : c.who === "Mira" ? (
                  <LiveDot className="mt-1.5 shrink-0" />
                ) : null}
              </button>
            </li>
          ))}
          {list.length === 0 ? (
            <li className="px-4 py-8 text-center text-[13px] text-muted-foreground">
              No conversations here.
            </li>
          ) : null}
        </ul>
      </section>
      <ChatThread />
    </div>
  );
}

/* -------------------------------------------------------------- Sidebar */

const sideItem = (active: boolean, nested?: boolean) =>
  cn(
    "flex h-7 w-full items-center gap-2 rounded-md text-left text-[13px]",
    nested ? "pr-2 pl-7" : "px-2",
    active
      ? "bg-nav-active font-medium text-nav-foreground"
      : "text-nav-muted hover:bg-nav-active hover:text-nav-foreground",
  );

function SideSection({
  label,
  defaultOpen = true,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-4 flex flex-col gap-px">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="mb-0.5 flex h-6 items-center gap-1 self-start rounded px-2 text-xs text-nav-muted hover:text-nav-foreground"
      >
        {label}
        <Chevron className="size-3" />
      </button>
      {open ? children : null}
    </div>
  );
}

const branchColour = ["bg-good", "bg-ai-strong", "bg-nav-muted"];

const sideIcon =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-nav-muted hover:bg-nav-active hover:text-nav-foreground";

/** Sub-topics of each section, shown in the extended sidebar. */
const subtopics: Record<PageId, { group: string; items: string[] }[]> = {
  home: [
    { group: "Today", items: ["Everything", "Waiting for you", "Mira is handling", "Handled"] },
    { group: "Look back", items: ["Yesterday", "This week"] },
  ],
  inbox: [
    { group: "Conversations", items: ["All open", "Needs a person", "Mira is handling", "Mine", "Closed"] },
    { group: "Channels", items: ["WhatsApp", "Instagram", "Website chat"] },
  ],
  customers: [
    { group: "People", items: ["Everyone", "New this week", "Booked", "Not seen in 6 months"] },
    { group: "Lists", items: ["VIP patients", "Whitening enquiries"] },
  ],
  agents: [
    { group: "Mira", items: ["Teach", "Try", "Go live", "Improve"] },
    { group: "Knowledge", items: ["Website", "Files", "Questions and answers"] },
  ],
  campaigns: [
    { group: "Campaigns", items: ["All", "Drafts", "Sending", "Sent"] },
    { group: "Messages", items: ["Approved messages", "Rejected"] },
  ],
  insights: [
    { group: "Reports", items: ["Overview", "Conversations", "AI agent", "Campaigns"] },
    { group: "Compare", items: ["Branches", "This week and last"] },
  ],
};

/** The extended sidebar: the current section's sub-topics, then the branch. */
function SubMenu({ homeLabel, onClose }: { homeLabel: string; onClose: () => void }) {
  const { page, branch, setBranch } = useLab();
  const [picked, setPicked] = useState<Partial<Record<PageId, string>>>({});
  const groups = subtopics[page];
  const current = picked[page] ?? groups[0]?.items[0];
  return (
    <div className="scroll-thin flex w-[196px] shrink-0 flex-col overflow-y-auto border-l border-nav-border px-2.5 pt-3 pb-2">
      <div className="mb-2 flex h-7 items-center gap-1">
        <h2 className="min-w-0 flex-1 truncate px-2 font-sans text-[13px] font-semibold">
          {page === "home" ? homeLabel : title[page]}
        </h2>
        <button
          type="button"
          aria-label="Close the sub-menu"
          title="Close the sub-menu"
          onClick={onClose}
          className={sideIcon}
        >
          <ChevronsLeft className="size-3.5" />
        </button>
      </div>
      <nav aria-label={`${title[page]} sections`} className="flex flex-col">
        {groups.map((g, gi) => (
          <div key={g.group} className={cn("flex flex-col gap-px", gi > 0 && "mt-4")}>
            <p className="mb-0.5 px-2 text-xs text-nav-muted">{g.group}</p>
            {g.items.map((it) => (
              <button
                key={it}
                type="button"
                aria-current={current === it ? "true" : undefined}
                onClick={() => setPicked({ ...picked, [page]: it })}
                className={sideItem(current === it)}
              >
                <span className="truncate">{it}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="mt-4 flex flex-col gap-px">
          <p className="mb-0.5 px-2 text-xs text-nav-muted">Branch</p>
          {branches.map((b, i) => (
            <button
              key={b}
              type="button"
              aria-pressed={branch === b}
              onClick={() => setBranch(b)}
              className={sideItem(branch === b)}
            >
              <span className={cn("size-3 shrink-0 rounded-sm", branchColour[i])} />
              <span className="truncate">{b}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** Icons only. Used by the rail arrangement and by the collapsed state. */
function IconRail({ homeLabel, onExpand }: { homeLabel: string; onExpand?: () => void }) {
  const { page, go, setPalette, thread, chats } = useLab();
  const waiting = chats.filter((c) => c.who === "Needs a person").length;
  const order: PageId[] = ["inbox", "home", "customers", "campaigns", "agents", "insights"];
  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 pt-3 pb-2">
      <span className="mb-2 inline-flex size-7 items-center justify-center">
        <span className="inline-flex size-5 items-center justify-center rounded bg-ai-strong text-ai-strong-foreground">
          <MessagesSquare className="size-3" />
        </span>
      </span>
      {order.map((id) => {
        const p = pages.find((x) => x.id === id);
        if (!p) return null;
        const active = page === id && !thread;
        const name = id === "home" ? homeLabel : title[id];
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={name}
                aria-current={active ? "page" : undefined}
                onClick={() => go(id)}
                className={cn(
                  "relative inline-flex size-8 items-center justify-center rounded-md",
                  active
                    ? "bg-nav-active text-nav-foreground"
                    : "text-nav-muted hover:bg-nav-active hover:text-nav-foreground",
                )}
              >
                <p.icon className="size-4" />
                {id === "inbox" && waiting ? (
                  <span className="absolute top-1 right-1 size-1.5 rounded-full bg-ai-strong" />
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{name}</TooltipContent>
          </Tooltip>
        );
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Ask Relay or search"
            onClick={() => setPalette(true)}
            className={cn(sideIcon, "mt-auto size-8")}
          >
            <Sparkles className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Ask Relay or search</TooltipContent>
      </Tooltip>
      {onExpand ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Expand the sidebar"
              onClick={onExpand}
              className={cn(sideIcon, "size-8")}
            >
              <PanelLeftOpen className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Expand the sidebar</TooltipContent>
        </Tooltip>
      ) : null}
      <span className="mt-1 inline-flex size-6 items-center justify-center rounded-full bg-nav-active text-[10px] font-semibold">
        PS
      </span>
    </div>
  );
}

/** The full labelled sidebar. `lean` drops the groups the sub-menu already covers. */
function FullNav({
  homeLabel,
  lean,
  onCollapse,
  width,
}: {
  homeLabel: string;
  lean?: boolean;
  onCollapse?: () => void;
  width: string;
}) {
  const { page, go, setPalette, chats, thread, branch, setBranch, ask, notify } = useLab();
  const [expanded, setExpanded] = useState<string>("Marina");
  const waiting = chats.filter((c) => c.who === "Needs a person").length;
  const label = (id: PageId) => (id === "home" ? homeLabel : title[id]);
  const link = (id: PageId) => {
    const p = pages.find((x) => x.id === id);
    if (!p) return null;
    const active = page === id && !thread;
    return (
      <button
        key={id}
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => go(id)}
        className={sideItem(active)}
      >
        <p.icon className="size-3.5 shrink-0" />
        <span className="flex-1 truncate">{label(id)}</span>
        {id === "inbox" && waiting ? <span className="text-xs tabular-nums">{waiting}</span> : null}
      </button>
    );
  };

  return (
    <div className={cn("scroll-thin flex shrink-0 flex-col overflow-y-auto px-2.5 pt-3 pb-2", width)}>
      <div className="mb-3 flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] font-semibold hover:bg-nav-active"
        >
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-ai-strong text-ai-strong-foreground">
            <MessagesSquare className="size-3" />
          </span>
          <span className="truncate">Lumen Clinics</span>
          <ChevronDown className="size-3 shrink-0 text-nav-muted" />
        </button>
        {onCollapse ? (
          <button type="button" aria-label="Collapse the sidebar" onClick={onCollapse} className={sideIcon}>
            <PanelLeftClose className="size-3.5" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Search"
            onClick={() => setPalette(true)}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-nav-muted hover:bg-nav-active hover:text-nav-foreground"
          >
            <Search className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label="New message"
          onClick={() => go("inbox")}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-nav-active text-nav-foreground"
        >
          <SquarePen className="size-3.5" />
        </button>
      </div>

      <nav aria-label="Main" className="flex flex-col">
        <div className="flex flex-col gap-px">
          {link("inbox")}
          {link("home")}
          <button type="button" onClick={() => setPalette(true)} className={sideItem(Boolean(thread))}>
            <Sparkles className="size-3.5 shrink-0" />
            <span className="flex-1">Ask Relay</span>
          </button>
        </div>

        <SideSection label="Workspace">
          {(["customers", "campaigns", "agents", "insights"] as const).map(link)}
        </SideSection>

        {lean ? null : (
          <>
            <SideSection label="Your branches">
              {branches.slice(0, 2).map((b, i) => (
                <div key={b} className="flex flex-col gap-px">
                  <button
                    type="button"
                    aria-expanded={expanded === b}
                    onClick={() => {
                      setBranch(b);
                      setExpanded(expanded === b ? "" : b);
                    }}
                    className={sideItem(false)}
                  >
                    <span className={cn("size-3.5 shrink-0 rounded", branchColour[i])} />
                    <span className={cn("truncate", branch === b && "font-medium text-nav-foreground")}>
                      {b}
                    </span>
                    {expanded === b ? (
                      <ChevronDown className="size-3 text-nav-muted" />
                    ) : (
                      <ChevronRight className="size-3 text-nav-muted" />
                    )}
                  </button>
                  {expanded === b
                    ? (["inbox", "customers", "campaigns"] as const).map((id) => {
                        const p = pages.find((x) => x.id === id);
                        if (!p) return null;
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => {
                              setBranch(b);
                              go(id);
                            }}
                            className={sideItem(false, true)}
                          >
                            <p.icon className="size-3.5 shrink-0" />
                            {title[id]}
                          </button>
                        );
                      })
                    : null}
                </div>
              ))}
              <button
                type="button"
                aria-pressed={branch === "All branches"}
                onClick={() => setBranch("All branches")}
                className={sideItem(false)}
              >
                <span className={cn("size-3.5 shrink-0 rounded", branchColour[2])} />
                <span className={cn(branch === "All branches" && "font-medium text-nav-foreground")}>
                  All branches
                </span>
              </button>
            </SideSection>

            <SideSection label="Recent requests" defaultOpen={false}>
              {recents.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => ask(r, true)}
                  className={sideItem(thread?.q === r)}
                >
                  <span className="truncate">{r}</span>
                </button>
              ))}
            </SideSection>
          </>
        )}

        <SideSection label="Try" defaultOpen={!lean}>
          {(
            [
              [Upload, "Import customers"],
              [UserPlus, "Invite people"],
              [Plug, "Connect a channel"],
            ] as const
          ).map(([Icon, text]) => (
            <button
              key={text}
              type="button"
              onClick={() => notify(`${text}: not part of this demo`)}
              className={sideItem(false)}
            >
              <Icon className="size-3.5 shrink-0" />
              {text}
            </button>
          ))}
        </SideSection>
      </nav>

      <div className="mt-auto flex items-center gap-2 px-1 pt-4">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-nav-active text-[10px] font-semibold">
          PS
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-nav-muted">Priya Shah</span>
        <button
          type="button"
          aria-label="Help"
          className="inline-flex size-6 items-center justify-center rounded text-nav-muted hover:bg-nav-active hover:text-nav-foreground"
        >
          <CircleHelp className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** A thin strip that brings the sub-menu back after it has been closed. */
function SubMenuHandle({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Show the sub-menu"
      title="Show the sub-menu"
      onClick={onOpen}
      className="flex w-5 shrink-0 items-center justify-center border-l border-nav-border text-nav-muted hover:bg-nav-active hover:text-nav-foreground"
    >
      <ChevronsRight className="size-3.5" />
    </button>
  );
}

/**
 * One arrangement of the sidebar. Every arrangement can fold the main menu down to icons,
 * and the ones with a sub-menu can close it.
 */
function SidebarBody({ homeLabel, variant }: { homeLabel: string; variant: SidebarId }) {
  const [collapsed, setCollapsed] = useState(variant === "rail" || variant === "collapsible");
  const [subOpen, setSubOpen] = useState(true);
  const hasSub = variant === "double" || variant === "rail";
  const main = collapsed ? (
    <IconRail homeLabel={homeLabel} onExpand={() => setCollapsed(false)} />
  ) : (
    <FullNav
      homeLabel={homeLabel}
      lean={hasSub}
      width={hasSub ? "w-[196px]" : "w-[224px]"}
      onCollapse={() => setCollapsed(true)}
    />
  );
  const sub = hasSub ? (
    subOpen ? (
      <SubMenu homeLabel={homeLabel} onClose={() => setSubOpen(false)} />
    ) : (
      <SubMenuHandle onOpen={() => setSubOpen(true)} />
    )
  ) : null;
  const shell = "hidden shrink-0 bg-nav text-nav-foreground md:flex";

  if (variant === "floating") {
    return (
      <aside className={cn(shell, "p-2 pr-0")}>
        <div className="flex overflow-hidden rounded-[14px] border border-nav-border bg-nav-active/40 shadow-soft">
          {main}
        </div>
      </aside>
    );
  }
  return (
    <aside className={shell}>
      {main}
      {sub}
    </aside>
  );
}

/** The sidebar every sidebar structure shares. The lab's Sidebar option picks the arrangement. */
export function LinearSidebar({ homeLabel = "Today" }: { homeLabel?: string }) {
  const { sidebar } = useLab();
  // Remount when the arrangement changes, so each one starts in its own default state.
  return <SidebarBody key={sidebar} homeLabel={homeLabel} variant={sidebar} />;
}

/* ---------------------------------------------------------------- Shell */

export function LinearShell() {
  const { page, go, setPalette, chats, thread, closeThread } = useLab();
  const live = chats.filter((c) => c.who === "Mira").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-nav text-nav-foreground">
      <div className="flex min-h-0 flex-1">
        <LinearSidebar homeLabel="My work" />

        <main className="m-2 mb-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card text-foreground md:ml-0">
          <header className="flex h-11 shrink-0 items-center gap-1 border-b px-3">
            <h1 className="px-1 font-sans text-[13px] font-medium">{thread ? "Ask Relay" : title[page]}</h1>
            <IconButton label="More">
              <MoreHorizontal className="size-4" />
            </IconButton>
            <div className="ml-auto flex items-center gap-0.5">
              {thread ? (
                <button
                  type="button"
                  onClick={closeThread}
                  className="h-7 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Close
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => go("inbox")}
                    className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="size-3.5" />
                    New message
                  </button>
                  <IconButton label="Filter">
                    <ListFilter className="size-4" />
                  </IconButton>
                  <IconButton label="Display options">
                    <SlidersHorizontal className="size-4" />
                  </IconButton>
                </>
              )}
            </div>
          </header>
          <CompactContext.Provider value={true}>
            <div className="flex min-h-0 flex-1 flex-col">
              {thread ? (
                <AssistantThread />
              ) : page === "home" ? (
                <WorkList />
              ) : page === "inbox" ? (
                <Conversations />
              ) : page === "customers" ? (
                <CustomersPage />
              ) : page === "agents" ? (
                <AgentsPage />
              ) : page === "campaigns" ? (
                <CampaignsPage />
              ) : (
                <InsightsPage />
              )}
            </div>
          </CompactContext.Provider>
        </main>
      </div>

      <footer className="flex h-8 shrink-0 items-center gap-3 px-3 text-xs text-nav-muted">
        <span className="inline-flex items-center gap-1.5">
          <LiveDot />
          Mira is replying to {live} {live === 1 ? "customer" : "customers"}
        </span>
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="ml-auto inline-flex h-6 items-center gap-1.5 rounded px-1.5 hover:bg-nav-active hover:text-nav-foreground"
        >
          <Sparkles className="size-3.5" />
          Ask Relay
          <kbd className="font-sans text-[11px]">⌘K</kbd>
        </button>
        <button
          type="button"
          aria-label="Recent activity"
          className="inline-flex size-6 items-center justify-center rounded hover:bg-nav-active hover:text-nav-foreground"
        >
          <History className="size-3.5" />
        </button>
      </footer>
    </div>
  );
}
