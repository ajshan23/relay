"use client";

import { initials } from "@relay/ui/components/person";
import { cn } from "@relay/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relay/ui/ui/tooltip";
// Icons: imported from lucide-react until the shared Icon component lands.
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  LogOut,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useState, useSyncExternalStore } from "react";
import { ContactsNav } from "@/components/contacts/contacts-nav";
import { InboxNav } from "@/components/inbox/inbox-nav";
import { signOut } from "@/lib/auth-client";
import { useMe } from "@/lib/me";
import { useBranch } from "./branch-context";
import { currentSubTopic, type Section, type SectionId, sectionForPath, sections } from "./nav-config";
import { ThemeToggle } from "./theme-toggle";

/*
 * The Linear-style sidebar chosen in the design lab: the full labelled menu plus the
 * current section's sub-menu. The main menu folds to an icon rail; the sub-menu closes
 * to a thin handle. Both choices are remembered in localStorage.
 */

/* ------------------------------------------------------------ storage */

const CHANGE_EVENT = "relay:sidebar-change";
const memory = new Map<string, string>();

function readFlag(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeFlag(key: string, value: boolean) {
  memory.set(key, String(value));
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage is unavailable; the in-memory value keeps the choice for this visit.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** A boolean kept in localStorage. The server render uses `fallback`. */
function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => readFlag(key),
    () => null,
  );
  const value = raw === null ? fallback : raw === "true";
  return [value, (next) => writeFlag(key, next)];
}

/* ------------------------------------------------------------ pieces */

const mainOrder: SectionId[] = ["today", "conversations"];
const workspaceOrder: SectionId[] = ["contacts", "automations", "broadcasts", "agents", "insights"];
const byId = (id: SectionId) => sections.find((s) => s.id === id) as Section;

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

const sideItem = (active: boolean) =>
  cn(
    "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-nav-active font-medium text-nav-foreground"
      : "text-nav-muted hover:bg-nav-active hover:text-nav-foreground",
  );

const sideIcon =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-nav-muted outline-none hover:bg-nav-active hover:text-nav-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** Colours that tell branches apart in the list, given out in order. */
const branchSwatches = ["bg-primary", "bg-good", "bg-warning", "bg-ai", "bg-danger"];

function WorkspaceMark() {
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
      <MessagesSquare className="size-3" />
    </span>
  );
}

/** The signed-in person: opens a menu with their account, settings and sign out. */
function AccountMenu({ side, showName }: { side: "top" | "right"; showName: boolean }) {
  const { me } = useMe();
  const { branches, branch } = useBranch();
  const switchBranch = useSwitchBranch();
  const router = useRouter();
  const leave = async () => {
    await signOut();
    router.replace("/sign-in");
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Your account"
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md outline-none hover:bg-nav-active focus-visible:ring-2 focus-visible:ring-ring",
            showName ? "flex-1 py-0.5 pr-1.5 pl-0.5" : "mt-1",
          )}
        >
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-nav-active text-[10px] font-semibold text-nav-foreground">
            {initials(me.user.name)}
          </span>
          {showName ? (
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-xs text-nav-foreground">{me.user.name}</span>
              {branch.id ? <span className="truncate text-[11px] text-nav-muted">{branch.name}</span> : null}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="start" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="truncate text-[13px] font-medium">{me.user.name}</span>
          <span className="truncate text-xs text-muted-foreground">{me.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {branches.length > 1 ? (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Branch
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={branch.id} onValueChange={switchBranch}>
              {branches.map((b, i) => (
                <DropdownMenuRadioItem key={b.id} value={b.id}>
                  <span
                    className={cn("size-2.5 shrink-0 rounded-sm", branchSwatches[i % branchSwatches.length])}
                  />
                  <span className="truncate">{b.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem asChild>
          <Link href="/settings/branches">
            <Settings className="size-3.5" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={leave}>
          <LogOut className="size-3.5" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RailButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} className={cn(sideIcon, "size-8")}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function SideGroup({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-4 flex flex-col gap-px">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="mb-0.5 flex h-6 items-center gap-1 self-start rounded-md px-2 text-xs text-nav-muted outline-none hover:text-nav-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <Chevron className="size-3" />
      </button>
      {open ? children : null}
    </div>
  );
}

/* ------------------------------------------------------------ main menu */

function FullNav({
  onCollapse,
  onOpenPalette,
  onOpenAsk,
}: {
  onCollapse: () => void;
  onOpenPalette: () => void;
  onOpenAsk: () => void;
}) {
  const pathname = usePathname();
  const { me } = useMe();
  const settingsActive = isActive(pathname, "/settings");
  const link = (id: SectionId) => {
    const s = byId(id);
    const active = isActive(pathname, s.href);
    return (
      <Link key={id} href={s.href} aria-current={active ? "page" : undefined} className={sideItem(active)}>
        <s.icon className="size-3.5 shrink-0" />
        <span className="flex-1 truncate">{s.label}</span>
      </Link>
    );
  };

  return (
    <div className="scroll-thin flex w-[196px] shrink-0 flex-col overflow-y-auto px-2.5 pt-3 pb-2">
      <div className="mb-2 flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-[13px] font-semibold">
          <WorkspaceMark />
          <span className="truncate">{me.organization?.name}</span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Collapse the sidebar" onClick={onCollapse} className={sideIcon}>
              <PanelLeftClose className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Collapse the sidebar</TooltipContent>
        </Tooltip>
      </div>

      <button type="button" onClick={onOpenPalette} className={cn(sideItem(false), "mb-2")}>
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1">Search</span>
        <kbd className="font-sans text-[11px] text-nav-muted">⌘K</kbd>
      </button>

      <nav aria-label="Main" className="flex flex-col">
        <div className="flex flex-col gap-px">
          {mainOrder.map(link)}
          <button type="button" onClick={onOpenAsk} className={sideItem(false)}>
            <Sparkles className="size-3.5 shrink-0" />
            <span className="flex-1">Ask Relay</span>
            <kbd className="font-sans text-[11px] text-nav-muted">⌘J</kbd>
          </button>
        </div>
        <SideGroup label="Workspace">{workspaceOrder.map(link)}</SideGroup>
      </nav>

      <Link
        href="/settings/branches"
        aria-current={settingsActive ? "page" : undefined}
        className={cn(sideItem(settingsActive), "mt-auto shrink-0")}
      >
        <Settings className="size-3.5 shrink-0" />
        <span className="flex-1 truncate">Settings</span>
      </Link>

      <div className="flex items-center gap-1 pt-2">
        <AccountMenu side="top" showName />
        <ThemeToggle className="size-6" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Help" className={cn(sideIcon, "size-6")}>
              <CircleHelp className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Help</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function IconRail({ onExpand, onOpenPalette }: { onExpand: () => void; onOpenPalette: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me } = useMe();
  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center gap-1 pt-3 pb-2">
      <span className="mb-2 inline-flex size-7 items-center justify-center" title={me.organization?.name}>
        <WorkspaceMark />
      </span>
      <nav aria-label="Main" className="flex flex-col items-center gap-1">
        {[...mainOrder, ...workspaceOrder].map((id) => {
          const s = byId(id);
          const active = isActive(pathname, s.href);
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <Link
                  href={s.href}
                  aria-label={s.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-nav-active text-nav-foreground"
                      : "text-nav-muted hover:bg-nav-active hover:text-nav-foreground",
                  )}
                >
                  <s.icon className="size-4" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{s.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col items-center gap-1">
        <RailButton label="Search or ask Relay" onClick={onOpenPalette}>
          <Search className="size-4" />
        </RailButton>
        <RailButton label="Settings" onClick={() => router.push("/settings/branches")}>
          <Settings className="size-4" />
        </RailButton>
        <ThemeToggle side="right" className="size-8" />
        <RailButton label="Expand the sidebar" onClick={onExpand}>
          <PanelLeftOpen className="size-4" />
        </RailButton>
        <AccountMenu side="right" showName={false} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ sub-menu */

/** The section's sub-topics. `current` is the selected view, or null while it is unknown. */
function SubTopicLinks({ section, current }: { section: Section; current: string | null }) {
  return section.groups.map((g, gi) => (
    <div key={g.label} className={cn("flex flex-col gap-px", gi > 0 && "mt-4")}>
      <p className="mb-0.5 px-2 text-xs text-nav-muted">{g.label}</p>
      {g.items.map((t) => (
        <Link
          key={t.view}
          href={t.href}
          aria-current={current === t.view ? "page" : undefined}
          className={sideItem(current === t.view)}
        >
          <span className="truncate">{t.label}</span>
        </Link>
      ))}
    </div>
  ));
}

/** Reads `?view=`, so it sits in its own Suspense boundary and the rest of the sidebar stays prerendered. */
function SubTopicLinksFromUrl({ section }: { section: Section }) {
  const view = useSearchParams().get("view");
  return <SubTopicLinks section={section} current={currentSubTopic(section, view)?.view ?? null} />;
}

/** Switches branch. Drops what belonged to the old one from the address: the open chat, a channel, a list or saved view. */
function useSwitchBranch() {
  const { branch, setBranch } = useBranch();
  const pathname = usePathname();
  const router = useRouter();
  return (id: string) => {
    if (id === branch.id) return;
    setBranch(id);
    if (pathname.startsWith("/conversations")) {
      const view = new URLSearchParams(window.location.search).get("view");
      router.replace(view ? `/conversations?view=${view}` : "/conversations", { scroll: false });
    } else if (pathname.startsWith("/contacts")) {
      const view = new URLSearchParams(window.location.search).get("view");
      // Built-in views exist in every branch; saved views and lists don't.
      router.replace(view && !view.startsWith("cview_") ? `/contacts?view=${view}` : "/contacts", {
        scroll: false,
      });
    }
  };
}

/** The second column: a title with a close button, then the section's own links. */
function SubMenuFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="scroll-thin flex w-[196px] shrink-0 flex-col overflow-y-auto border-l border-nav-border px-2.5 pt-3 pb-2">
      <div className="mb-2 flex h-7 items-center gap-1">
        <h2 className="min-w-0 flex-1 truncate px-2 text-[13px] font-semibold">{title}</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Close the sub-menu" onClick={onClose} className={sideIcon}>
              <ChevronsLeft className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Close the sub-menu</TooltipContent>
        </Tooltip>
      </div>
      {children}
    </div>
  );
}

/** Settings pages, grouped. Each is its own route, so the current one comes from the path. */
const settingsGroups = [
  {
    label: "Business",
    items: [
      { label: "Branches", href: "/settings/branches" },
      { label: "Team", href: "/settings/team" },
    ],
  },
  {
    label: "Messaging",
    items: [
      { label: "Channels", href: "/settings/channels" },
      { label: "Templates", href: "/settings/templates" },
      { label: "Quick replies", href: "/settings/quick-replies" },
      { label: "Broadcasts", href: "/settings/broadcasts" },
    ],
  },
];

function SettingsSubMenu({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  return (
    <SubMenuFrame title="Settings" onClose={onClose}>
      <nav aria-label="Settings pages" className="flex flex-col">
        {settingsGroups.map((g, gi) => (
          <div key={g.label} className={cn("flex flex-col gap-px", gi > 0 && "mt-4")}>
            <p className="mb-0.5 px-2 text-xs text-nav-muted">{g.label}</p>
            {g.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={sideItem(active)}
                >
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </SubMenuFrame>
  );
}

function SubMenu({ section, onClose }: { section: Section; onClose: () => void }) {
  return (
    <div className="scroll-thin flex w-[196px] shrink-0 flex-col overflow-y-auto border-l border-nav-border px-2.5 pt-3 pb-2">
      <div className="mb-2 flex h-7 items-center gap-1">
        <h2 className="min-w-0 flex-1 truncate px-2 text-[13px] font-semibold">{section.label}</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Close the sub-menu" onClick={onClose} className={sideIcon}>
              <ChevronsLeft className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Close the sub-menu</TooltipContent>
        </Tooltip>
      </div>
      <nav aria-label={`${section.label} views`} className="flex flex-col">
        <Suspense fallback={<SubTopicLinks section={section} current={null} />}>
          {section.id === "conversations" ? (
            <InboxNav section={section} itemClass={sideItem} />
          ) : section.id === "contacts" ? (
            <ContactsNav itemClass={sideItem} />
          ) : (
            <SubTopicLinksFromUrl section={section} />
          )}
        </Suspense>
      </nav>
    </div>
  );
}

/** A thin strip that brings the sub-menu back after it has been closed. */
function SubMenuHandle({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Show the sub-menu"
          onClick={onOpen}
          className="flex w-5 shrink-0 items-center justify-center border-l border-nav-border text-nav-muted outline-none hover:bg-nav-active hover:text-nav-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronsRight className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Show the sub-menu</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------ sidebar */

export function Sidebar({ onOpenPalette, onOpenAsk }: { onOpenPalette: () => void; onOpenAsk: () => void }) {
  const pathname = usePathname();
  const section = sectionForPath(pathname);
  const inSettings = isActive(pathname, "/settings");
  const [collapsed, setCollapsed] = useStoredFlag("relay.sidebar.collapsed", false);
  const [subOpen, setSubOpen] = useStoredFlag("relay.sidebar.submenu-open", true);

  return (
    <aside
      aria-label="Sidebar"
      className="hidden shrink-0 border-r border-nav-border bg-nav text-nav-foreground md:flex"
    >
      {collapsed ? (
        <IconRail onExpand={() => setCollapsed(false)} onOpenPalette={onOpenPalette} />
      ) : (
        <FullNav onCollapse={() => setCollapsed(true)} onOpenPalette={onOpenPalette} onOpenAsk={onOpenAsk} />
      )}
      {section || inSettings ? (
        !subOpen ? (
          <SubMenuHandle onOpen={() => setSubOpen(true)} />
        ) : section ? (
          <SubMenu section={section} onClose={() => setSubOpen(false)} />
        ) : (
          <SettingsSubMenu pathname={pathname} onClose={() => setSubOpen(false)} />
        )
      ) : null}
    </aside>
  );
}
