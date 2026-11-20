"use client";

import { Icon, type IconName } from "@relay/ui/components/icon";
import { Person } from "@relay/ui/components/person";
import { SearchInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@relay/ui/ui/empty";
import { Item, ItemContent, ItemMedia } from "@relay/ui/ui/item";
import { Label } from "@relay/ui/ui/label";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Switch } from "@relay/ui/ui/switch";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { listTime, members, previewLine } from "./format";
import { type ListFilter, useChannels, useConversations, useCounts } from "./queries";
import { NewConversationDialog, useBranchNumbers } from "./start-conversation";
import type { ConversationRow, InboxView } from "./types";

export const viewLabels: Record<InboxView, string> = {
  open: "Open",
  mine: "Assigned to me",
  unassigned: "Unassigned",
  mentions: "Mentions",
  snoozed: "Snoozed",
  closed: "Closed",
};

/** Display only: which logo to show for a channel type. Behaviour never depends on it. */
export const channelIcon = (type: string): IconName =>
  type === "whatsapp" ? "whatsapp" : type === "instagram" ? "instagram" : "website";

type Props = {
  filter: ListFilter;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onViewChange: (view: InboxView) => void;
  onSearch: (q: string) => void;
  className?: string;
};

/**
 * The chat list (shadcn sidebar-09 layout: title with an unread switch, search, then rows).
 * Pages load as the list scrolls; live events refresh it in place.
 */
export function ConversationList({ filter, selectedId, onSelect, onViewChange, onSearch, className }: Props) {
  const list = useConversations(filter);
  const counts = useCounts(filter.branch);
  const channels = useChannels();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [composing, setComposing] = useState(false);
  const { numbers } = useBranchNumbers();
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.conversations) ?? [], [list.data]);
  const shown = unreadOnly ? rows.filter((r) => r.unreadCount > 0 || r.id === selectedId) : rows;
  const channelName = channels.data?.find((c) => c.id === filter.channel)?.displayName;

  // Load the next page when the end of the list comes into view.
  const end = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = end.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const count = (v: InboxView) => counts.data?.[v];

  return (
    <section aria-label="Conversations" className={cn("flex min-h-0 flex-col bg-card", className)}>
      <header className="flex flex-col gap-3 border-b px-4 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger className="-ml-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-base font-semibold outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
              <span className="truncate">{viewLabels[filter.view]}</span>
              <Icon name="chevronDown" size="sm" className="text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuRadioGroup value={filter.view} onValueChange={(v) => onViewChange(v as InboxView)}>
                {(Object.keys(viewLabels) as InboxView[]).map((v) => (
                  <DropdownMenuRadioItem key={v} value={v} className="justify-between">
                    {viewLabels[v]}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {count(v) ?? ""}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
            <Label htmlFor="unread-only" className="font-normal text-muted-foreground">
              Unread
            </Label>
            <Switch id="unread-only" checked={unreadOnly} onCheckedChange={setUnreadOnly} />
            {numbers.length ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="New conversation"
                title="New conversation"
                onClick={() => setComposing(true)}
              >
                <Icon name="compose" />
              </Button>
            ) : null}
          </span>
        </div>
        <SearchInput
          size="sm"
          placeholder="Search name, number or group"
          aria-label="Search conversations"
          defaultValue={filter.q}
          onSearch={onSearch}
        />
        {channelName ? (
          <p className="-mt-1 truncate text-xs text-muted-foreground">
            On <span className="font-medium text-foreground">{channelName}</span>
          </p>
        ) : null}
        {counts.data?.partial ? (
          <p className="-mt-1 text-xs text-muted-foreground">
            Showing the chats your role lets you see in this branch.
          </p>
        ) : null}
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
        {list.isPending ? (
          <ListSkeleton />
        ) : list.isError ? (
          <ListEmpty
            icon="alert"
            title="Conversations didn't load"
            description="Check your connection; the list retries on its own."
          />
        ) : !shown.length ? (
          filter.q ? (
            <ListEmpty icon="search" title="No matches" description={`Nothing found for "${filter.q}".`} />
          ) : unreadOnly ? (
            <ListEmpty icon="check" title="All caught up" description="No unread conversations here." />
          ) : channels.data && channels.data.length === 0 ? (
            <ListEmpty
              icon="whatsapp"
              title="No channels yet"
              description="Connect a WhatsApp number and its chats show up here."
            />
          ) : (
            <ListEmpty
              icon="inbox"
              title={
                filter.view === "mine"
                  ? "Nothing assigned to you"
                  : filter.view === "mentions"
                    ? "No mentions"
                    : filter.view === "snoozed"
                      ? "Nothing snoozed"
                      : "No conversations"
              }
              description={
                filter.view === "closed"
                  ? "Closed conversations land here."
                  : filter.view === "mentions"
                    ? "When a teammate @mentions you in a note, the conversation shows up here."
                    : filter.view === "snoozed"
                      ? "Snoozed conversations wait here and come back on time, or when the customer writes."
                      : "New messages appear here as they arrive."
              }
            />
          )
        ) : (
          <ul className="flex flex-col gap-px">
            {shown.map((row) => (
              <li key={row.id}>
                <ConversationItem row={row} selected={row.id === selectedId} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        )}
        <div ref={end} className="h-px" />
        {isFetchingNextPage ? <ListSkeleton rows={2} /> : null}
      </div>
      <NewConversationDialog open={composing} onOpenChange={setComposing} />
    </section>
  );
}

function ConversationItem({
  row,
  selected,
  onSelect,
}: {
  row: ConversationRow;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const unread = row.unreadCount > 0;
  return (
    <Item
      asChild
      size="sm"
      className={cn(
        "w-full flex-nowrap items-start gap-3 px-2.5 py-2.5 text-left hover:bg-muted",
        selected && "bg-accent hover:bg-accent",
      )}
    >
      <button type="button" aria-current={selected ? "true" : undefined} onClick={() => onSelect(row.id)}>
        <ItemMedia className="relative self-start">
          {row.kind === "group" ? (
            <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Icon name="users" />
            </span>
          ) : (
            <Person name={row.title} size="lg" decorative />
          )}
          <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-4 items-center justify-center rounded-full bg-card ring-2 ring-card">
            <Icon name={channelIcon(row.channelType)} size="xs" className="text-muted-foreground" />
          </span>
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}>
              {row.title}
            </span>
            <time
              dateTime={row.activityAt}
              className={cn(
                "shrink-0 text-xs tabular-nums",
                unread ? "font-medium text-primary" : "text-muted-foreground",
              )}
            >
              {listTime(row.activityAt)}
            </time>
          </span>
          <span className="flex items-center justify-between gap-2">
            <span className={cn("truncate text-sm", unread ? "text-foreground" : "text-muted-foreground")}>
              {previewLine(row.preview, row.kind)}
            </span>
            {unread ? (
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums">
                {row.unreadCount > 99 ? "99+" : row.unreadCount}
              </span>
            ) : null}
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{row.channelName}</span>
            {row.kind === "group" && row.participantCount !== null ? (
              <span className="shrink-0">· {members(row.participantCount)}</span>
            ) : null}
            {row.status === "closed" ? <span className="shrink-0">· Closed</span> : null}
            <span className="ml-auto shrink-0">
              {row.assignee ? (
                <Person name={row.assignee.name} src={row.assignee.image ?? undefined} size="xs" />
              ) : null}
            </span>
          </span>
        </ItemContent>
      </button>
    </Item>
  );
}

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1 p-1" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex gap-3 p-1.5">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ListEmpty({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return (
    <Empty className="border-0 py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon name={icon} />
        </EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
