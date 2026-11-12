"use client";

import { ArrowLeft, Menu, MessagesSquare, Search, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { AskBox, BranchMenu, NeedsList, Person, StatTiles } from "@/components/bits";
import {
  AskBar,
  AssistantThread,
  BoardHome,
  BriefingHome,
  Greeting,
  LedgerHome,
  Suggestions,
  TriageHome,
} from "@/components/homes";
import { LinearSidebar } from "@/components/linear";
import {
  AgentsPage,
  CampaignsPage,
  CustomersPage,
  FolioInbox,
  InboxPage,
  InsightsPage,
} from "@/components/pages";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type PageId, pages } from "@/lib/data";
import { useLab } from "@/lib/store";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------- shared parts */

function Brand({ onNav, className }: { onNav?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-lg",
          onNav ? "bg-ai-strong text-ai-strong-foreground" : "bg-primary text-primary-foreground",
        )}
      >
        <MessagesSquare className="size-[18px]" />
      </span>
      <span className="font-display text-lg font-semibold tracking-tight">Relay</span>
    </span>
  );
}

function needCount(needs: number, id: PageId) {
  return id === "inbox" ? needs : 0;
}

/** Renders the current page. Each structure decides what its home and inbox look like. */
function Page({ home, inbox }: { home: ReactNode; inbox: ReactNode }) {
  const { page } = useLab();
  if (page === "home") return <>{home}</>;
  if (page === "inbox") return <>{inbox}</>;
  if (page === "customers") return <CustomersPage />;
  if (page === "agents") return <AgentsPage />;
  if (page === "campaigns") return <CampaignsPage />;
  return <InsightsPage />;
}

/* ------------------------------------------- 1. Assistant: dark sidebar */

export function AssistantShell() {
  const { page, thread } = useLab();
  return (
    <div className="flex min-h-0 flex-1">
      <LinearSidebar homeLabel="Today" />
      <main className="flex min-w-0 flex-1 flex-col">
        <MobileBar />
        <Page home={<BoardHome />} inbox={<InboxPage />} />
        {thread || page === "inbox" ? null : <AskBar />}
      </main>
    </div>
  );
}

function MobileBar() {
  const { go, page } = useLab();
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 bg-nav px-3 text-nav-foreground md:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            className="text-nav-foreground hover:bg-nav-active hover:text-nav-foreground"
          >
            <Menu />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {pages.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => go(p.id)}>
              <p.icon />
              {p.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="font-display font-semibold">{pages.find((p) => p.id === page)?.label}</span>
    </div>
  );
}

/* ------------------------------------------------ 2. Console: icon rail */

export function ConsoleShell() {
  const { page, go, setPalette, chats } = useLab();
  const waiting = chats.filter((c) => c.who === "Needs a person").length;
  const current = page === "home" ? "inbox" : page;
  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Main"
        className="hidden w-[60px] shrink-0 flex-col items-center gap-1 bg-nav py-3 text-nav-muted md:flex"
      >
        <span className="mb-3 inline-flex size-9 items-center justify-center rounded-lg bg-ai-strong text-ai-strong-foreground">
          <MessagesSquare className="size-5" />
        </span>
        {pages
          .filter((p) => p.id !== "home")
          .map((p) => (
            <Tooltip key={p.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={p.label}
                  aria-current={current === p.id ? "page" : undefined}
                  onClick={() => go(p.id)}
                  className={cn(
                    "relative inline-flex size-10 items-center justify-center rounded-lg",
                    current === p.id
                      ? "bg-nav-active text-nav-foreground"
                      : "hover:bg-nav-active hover:text-nav-foreground",
                  )}
                >
                  <p.icon className="size-5" />
                  {needCount(waiting, p.id) ? (
                    <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-ai-strong" />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{p.label}</TooltipContent>
            </Tooltip>
          ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Search"
              onClick={() => setPalette(true)}
              className="mt-auto inline-flex size-10 items-center justify-center rounded-lg hover:bg-nav-active hover:text-nav-foreground"
            >
              <Search className="size-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Search, ⌘K</TooltipContent>
        </Tooltip>
        <span className="inline-flex size-8 items-center justify-center rounded-full bg-nav-active text-[11px] font-semibold text-nav-foreground">
          PS
        </span>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <MobileBar />
        <Page home={<InboxPage panes={3} />} inbox={<InboxPage panes={3} />} />
      </main>
    </div>
  );
}

/* ------------------------------------------- 3. Messenger: chats first */

export function MessengerShell() {
  const { page, go, ask } = useLab();
  const onChats = page === "home" || page === "inbox";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
        {onChats ? (
          <>
            <Person name="Priya Shah" />
            <div className="min-w-0 leading-tight">
              <p className="truncate font-semibold">Lumen Clinics</p>
              <p className="text-xs text-muted-foreground">Mira is replying to 3 chats</p>
            </div>
          </>
        ) : (
          <Button variant="ghost" onClick={() => go("home")}>
            <ArrowLeft />
            Chats
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <BranchMenu />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Menu />
                More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {pages
                .filter((p) => p.id !== "home" && p.id !== "inbox")
                .map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => go(p.id)}>
                    <p.icon />
                    {p.label}
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => ask("Show this week's numbers")}>
                <Sparkles />
                Ask the assistant
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Page home={<MessengerHome />} inbox={<InboxPage wide wallpaper />} />
      </main>
    </div>
  );
}

function MessengerHome() {
  const { thread } = useLab();
  return thread ? <AssistantThread /> : <InboxPage wide wallpaper />;
}

/* -------------------------------------- 4. Briefing: labelled light sidebar */

export function BriefingShell() {
  return (
    <div className="flex min-h-0 flex-1">
      <LinearSidebar homeLabel="Today" />
      <main className="flex min-w-0 flex-1 flex-col">
        <MobileBar />
        <Page home={<BriefingHome />} inbox={<InboxPage />} />
      </main>
    </div>
  );
}

/* --------------------------------------------- 5. Top bar: centred column */

function CentredHome() {
  const { thread } = useLab();
  if (thread) return <AssistantThread />;
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-10 sm:py-14">
        <Greeting big />
        <AskBox placeholder="Ask for a campaign, a report, or a change to how Mira answers" />
        <div className="-mt-3">
          <Suggestions />
        </div>
        <section aria-label="Needs you" className="flex flex-col gap-3">
          <h2 className="font-semibold">Needs you</h2>
          <NeedsList />
        </section>
        <section aria-label="Today" className="flex flex-col gap-3">
          <h2 className="font-semibold">Today</h2>
          <StatTiles className="grid-cols-2 lg:grid-cols-4" />
        </section>
      </div>
    </div>
  );
}

export function TopbarShell() {
  const { page, go, setPalette, chats } = useLab();
  const waiting = chats.filter((c) => c.who === "Needs a person").length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 bg-nav px-4 text-nav-foreground">
        <Brand onNav className="mr-3" />
        <nav aria-label="Main" className="hidden items-center gap-0.5 lg:flex">
          {pages.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-current={page === p.id ? "page" : undefined}
              onClick={() => go(p.id)}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm",
                page === p.id
                  ? "bg-nav-active font-semibold"
                  : "text-nav-muted hover:bg-nav-active hover:text-nav-foreground",
              )}
            >
              {p.label}
              {needCount(waiting, p.id) ? (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ai-strong px-1.5 text-[11px] font-bold text-ai-strong-foreground">
                  {waiting}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="lg:hidden">
          <MobileMenuOnNav />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="hidden h-9 w-56 items-center gap-2 rounded-md border border-nav-border px-3 text-sm text-nav-muted hover:bg-nav-active sm:flex"
          >
            <Search className="size-4" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="rounded border border-nav-border px-1.5 font-sans text-[11px]">⌘K</kbd>
          </button>
          <BranchMenu onNav />
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-nav-active text-[11px] font-semibold">
            PS
          </span>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Page home={<CentredHome />} inbox={<InboxPage />} />
      </main>
    </div>
  );
}

function MobileMenuOnNav() {
  const { go } = useLab();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open menu"
          className="text-nav-foreground hover:bg-nav-active hover:text-nav-foreground"
        >
          <Menu />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {pages.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => go(p.id)}>
            <p.icon />
            {p.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ----------------------------------------------- 6. Dock: floating nav */

export function DockShell() {
  const { page, go, setPalette, chats } = useLab();
  const waiting = chats.filter((c) => c.who === "Needs a person").length;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 px-5">
        <Brand />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPalette(true)}>
            <Search />
            Search
          </Button>
          <BranchMenu />
          <Person name="Priya Shah" className="size-8" />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Page home={<TriageHome />} inbox={<InboxPage />} />
      </main>
      <nav
        aria-label="Main"
        className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full bg-nav p-1.5 text-nav-muted shadow-2xl"
      >
        {pages.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-label={p.id === "home" ? "Decisions" : p.label}
            aria-current={page === p.id ? "page" : undefined}
            onClick={() => go(p.id)}
            className={cn(
              "relative inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm",
              page === p.id
                ? "bg-nav-active font-semibold text-nav-foreground"
                : "hover:bg-nav-active hover:text-nav-foreground",
            )}
          >
            <p.icon className="size-[18px]" />
            {page === p.id ? <span>{p.id === "home" ? "Decisions" : p.label}</span> : null}
            {needCount(waiting, p.id) && page !== p.id ? (
              <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-ai-strong" />
            ) : null}
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ------------------------------ 7. Ledger: a sheet set into the page */

const _ledgerLabel: Partial<Record<PageId, string>> = {
  home: "Today",
  inbox: "Conversations",
  agents: "AI agent",
};

export function LedgerShell() {
  const { page, thread } = useLab();
  return (
    <div className="flex min-h-0 flex-1 bg-nav text-nav-foreground">
      <LinearSidebar homeLabel="Today" />
      <main className="m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border bg-card text-foreground shadow-soft md:ml-0">
        <MobileBar />
        <div
          key={`${page}-${thread ? "thread" : "page"}`}
          className="slide-in-from-bottom-1 flex min-h-0 flex-1 animate-in flex-col duration-200"
        >
          <Page home={<LedgerHome />} inbox={<FolioInbox />} />
        </div>
      </main>
    </div>
  );
}
