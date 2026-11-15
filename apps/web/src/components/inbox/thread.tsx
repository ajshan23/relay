"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { Icon } from "@relay/ui/components/icon";
import { Modal } from "@relay/ui/components/modal";
import { Person } from "@relay/ui/components/person";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@relay/ui/ui/empty";
import { Marker, MarkerContent } from "@relay/ui/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@relay/ui/ui/message-scroller";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Spinner } from "@relay/ui/ui/spinner";
import { type DragEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AutomationBanner, RunAutomationButton } from "@/components/automations/chat-controls";
import { DateSeparator } from "@/components/ui/whatsapp/date-separator";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";
import { cn } from "@/lib/utils";
import { ChatSearch } from "./chat-search";
import { Composer } from "./composer";
import { channelIcon } from "./conversation-list";
import { DetailsPanel } from "./details-panel";
import { dayLabel, members } from "./format";
import { MessageBubble } from "./message-bubble";
import { names, usePresence, usePresenceReporter } from "./presence";
import {
  useAssignees,
  useConversation,
  useDeleteNote,
  useMarkRead,
  useMessages,
  useReact,
  useRetry,
  useUpdateConversation,
} from "./queries";
import type { ConversationDetail, Message } from "./types";

type Props = { id: string; onBack: () => void; className?: string };

export function Thread({ id, onBack, className }: Props) {
  const detail = useConversation(id);
  const messages = useMessages(id);
  const markRead = useMarkRead();
  usePresenceReporter(id);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [dropped, setDropped] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [details, setDetails] = useState(false);
  /** Searching inside this chat, and the match to highlight. */
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new conversation closes the search
  useEffect(() => {
    setSearching(false);
    setHighlight(null);
  }, [id]);
  useEffect(() => {
    const onKey = (e: Event) => {
      if ((e as CustomEvent<string>).detail === "search") setSearching(true);
    };
    window.addEventListener("relay:inbox-shortcut", onKey);
    return () => window.removeEventListener("relay:inbox-shortcut", onKey);
  }, []);

  const list = useMemo(
    () => (messages.data ? [...messages.data.pages].reverse().flatMap((p) => p.messages) : []),
    [messages.data],
  );
  const newestInbound = [...list].reverse().find((m) => m.direction === "inbound")?.id;

  // Opening a conversation, and every new customer message while it is open, marks it read for you.
  // Where the new messages started when you opened this chat ("3 unread messages"), kept for the visit.
  const [unreadSince, setUnreadSince] = useState<{ id: string; at: string | null; openedAt: number } | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: markRead is stable enough; run on id or new inbound
  useEffect(() => {
    if (id && document.visibilityState === "visible")
      // Every call resolves (mutate's callbacks only run for the latest), and only the first one
      // of a visit knows when you last looked.
      void markRead
        .mutateAsync(id)
        .then((r) =>
          setUnreadSince((prev) =>
            prev?.id === id ? prev : { id, at: r?.previousReadAt ?? null, openedAt: Date.now() },
          ),
        )
        .catch(() => undefined);
  }, [id, newestInbound]);

  // The first customer message you hadn't seen, and how many came after it.
  const unread = useMemo(() => {
    if (!unreadSince || unreadSince.id !== id) return null;
    const since = unreadSince.at ? new Date(unreadSince.at).getTime() : Number.NEGATIVE_INFINITY;
    const fresh = list.filter(
      (m) =>
        m.direction === "inbound" &&
        new Date(m.sentAt).getTime() > since &&
        new Date(m.sentAt).getTime() <= unreadSince.openedAt,
    );
    if (!fresh.length) return null;
    // Replying means you've caught up: the divider goes.
    const replied = list.some(
      (m) =>
        m.direction === "outbound" &&
        m.type !== "note" &&
        new Date(m.sentAt).getTime() > unreadSince.openedAt,
    );
    return replied ? null : { fromId: fresh[0]?.id ?? "", count: fresh.length };
  }, [list, unreadSince, id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new conversation clears the reply target
  useEffect(() => setReplyTo(null), [id]);

  if (detail.isError) {
    const gone = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <section className={cn("flex flex-1 items-center justify-center", className)}>
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="alert" />
            </EmptyMedia>
            <EmptyTitle>{gone ? "Conversation not found" : "This conversation didn't load"}</EmptyTitle>
            <EmptyDescription>
              {gone
                ? "It may be in a branch you can't reach, or the link is wrong."
                : "Check your connection and try again."}
            </EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={onBack} className="lg:hidden">
            Back to conversations
          </Button>
        </Empty>
      </section>
    );
  }

  const d = detail.data;
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setDropped(f);
  };

  return (
    <section
      aria-label={d ? `Conversation with ${d.conversation.title}` : "Conversation"}
      className={cn("relative flex min-h-0 min-w-0 flex-col bg-background", className)}
      onDragOver={(e) => {
        if (!d?.canWork || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <ThreadHeader
        detail={d}
        onBack={onBack}
        onDetails={() => setDetails(true)}
        onSearch={() => setSearching((s) => !s)}
      />
      {d?.conversation.kind === "direct" ? <AutomationBanner conversationId={id} /> : null}

      <div className="relative min-h-0 flex-1">
        {messages.isPending || !d ? (
          <ThreadSkeleton />
        ) : (
          <MessageScrollerProvider key={id} autoScroll defaultScrollPosition="end">
            {searching ? (
              <ChatSearch
                conversationId={id}
                list={list}
                loadOlder={async () => {
                  if (!messages.hasNextPage) return false;
                  await messages.fetchNextPage();
                  return true;
                }}
                onHighlight={setHighlight}
                onClose={() => {
                  setSearching(false);
                  setHighlight(null);
                }}
              />
            ) : null}
            <MessageScroller>
              <MessageScrollerViewport preserveScrollOnPrepend>
                <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-0 px-4 py-4 sm:px-6">
                  {messages.hasNextPage ? (
                    <div className="flex justify-center pb-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void messages.fetchNextPage()}
                        disabled={messages.isFetchingNextPage}
                      >
                        {messages.isFetchingNextPage ? <Spinner /> : <Icon name="arrowUp" />}
                        Earlier messages
                      </Button>
                    </div>
                  ) : (
                    <Marker variant="separator" className="pb-4 text-xs">
                      <MarkerContent>
                        Conversation started {dayLabel(d.conversation.createdAt).toLowerCase()}
                      </MarkerContent>
                    </Marker>
                  )}
                  <Messages
                    list={list}
                    unread={unread}
                    highlight={highlight}
                    detail={d}
                    onReply={d.canWork && d.conversation.windowOpen ? setReplyTo : undefined}
                    canReact={d.canWork && d.conversation.windowOpen && !!d.capabilities?.reactions}
                  />
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <NewMessagesButton list={list} />
              <ScrollToUnread messageId={unread?.fromId ?? null} />
            </MessageScroller>
          </MessageScrollerProvider>
        )}
        {dragging ? (
          <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
            Drop to attach
          </div>
        ) : null}
      </div>

      <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-4">
        <TeammatesTyping conversationId={id} />
        {d ? (
          <Composer
            detail={d}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            dropped={dropped}
            onDroppedHandled={() => setDropped(null)}
          />
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </div>
      {d ? <DetailsPanel detail={d} open={details} onOpenChange={setDetails} /> : null}
    </section>
  );
}

function Messages({
  list,
  unread,
  highlight,
  detail,
  onReply,
  canReact,
}: {
  list: Message[];
  /** Where the new messages start, and how many: shown as a divider. */
  unread: { fromId: string; count: number } | null;
  /** A search match to point out. */
  highlight: string | null;
  detail: ConversationDetail;
  onReply?: (m: Message) => void;
  canReact?: boolean;
}) {
  const retry = useRetry(detail.conversation.id);
  const react = useReact(detail.conversation.id);
  const onReact = (m: Message, emoji: string) =>
    react.mutate(
      { messageId: m.id, emoji },
      {
        onError: (err) =>
          notify.error("Reaction not sent", {
            description: err instanceof ApiError ? err.message : undefined,
          }),
      },
    );
  const deleteNote = useDeleteNote(detail.conversation.id);
  const { me, canManageOrg } = useMe();
  const onDeleteNote = (m: Message) =>
    deleteNote.mutate(m.id, {
      onError: (err) =>
        notify.error("Couldn't delete the note", {
          description: err instanceof ApiError ? err.message : undefined,
        }),
    });
  const [confirm, confirmElement] = useConfirm();
  const isGroup = detail.conversation.kind === "group";
  // Sending again only makes sense while a send could succeed.
  const canRetry =
    detail.canWork &&
    detail.conversation.windowOpen &&
    detail.channel.status === "active" &&
    (!detail.group || detail.group.status === "active");

  async function onRetry(m: Message) {
    const run = (confirmed: boolean) =>
      retry.mutateAsync({ messageId: m.id, confirm: confirmed }).catch(async (err) => {
        if (err instanceof ApiError && err.code === "may_be_sent") {
          const ok = await confirm({
            title: "Send it again?",
            description:
              "This message may already have reached the customer. Sending again could duplicate it.",
            confirmLabel: "Send again",
          });
          if (ok) await run(true);
          return;
        }
        notify.error("Couldn't send it again", {
          description: err instanceof ApiError ? err.message : "Check your connection.",
        });
      });
    await run(false);
  }

  if (!list.length)
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No messages yet. Send the first one below; their replies show up here.
      </p>
    );

  const rows = list.map((m, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    const newDay = !prev || new Date(prev.sentAt).toDateString() !== new Date(m.sentAt).toDateString();
    const sameRun = (a?: Message, b?: Message) =>
      !!a &&
      !!b &&
      a.direction === b.direction &&
      (a.sender.id ?? a.sender.name) === (b.sender.id ?? b.sender.name) &&
      Math.abs(new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime()) < 5 * 60_000 &&
      new Date(a.sentAt).toDateString() === new Date(b.sentAt).toDateString();
    const first = newDay || !sameRun(prev, m);
    const last = !sameRun(m, next);
    return (
      <Fragment key={m.id}>
        {newDay ? <DateSeparator label={dayLabel(m.sentAt)} className="py-3" /> : null}
        {unread?.fromId === m.id ? (
          <Marker variant="separator" className="py-3 text-xs font-medium text-primary" data-unread-divider>
            <MarkerContent>
              {unread.count} unread {unread.count === 1 ? "message" : "messages"}
            </MarkerContent>
          </Marker>
        ) : null}
        {/* Follow-ups in a run sit close, but never touch: photos and videos have no padding of their own. */}
        <MessageScrollerItem
          messageId={m.id}
          className={cn(
            first ? "pt-2" : "pt-1",
            "rounded-lg transition-colors duration-500",
            highlight === m.id && "bg-primary/10",
          )}
        >
          <MessageBubble
            message={m}
            first={first}
            last={last}
            isGroup={isGroup}
            onReply={onReply}
            onReact={canReact ? onReact : undefined}
            onRetry={canRetry ? onRetry : undefined}
            onDeleteNote={m.sender.id === me.user.id || canManageOrg ? onDeleteNote : undefined}
          />
        </MessageScrollerItem>
      </Fragment>
    );
  });
  return (
    <>
      {rows}
      {confirmElement}
    </>
  );
}

function ThreadHeader({
  detail: d,
  onBack,
  onDetails,
  onSearch,
}: {
  detail: ConversationDetail | undefined;
  onBack: () => void;
  onDetails: () => void;
  onSearch: () => void;
}) {
  const update = useUpdateConversation(d?.conversation.id ?? "");
  const { me } = useMe();
  const [menuOpen, setMenuOpen] = useState(false);
  const people = useAssignees(d?.conversation.id ?? "", !!d && menuOpen);
  const closeRef = useRef<HTMLButtonElement>(null);
  const changeRef = useRef<(status: "open" | "closed") => void>(() => undefined);
  useEffect(() => {
    const onKey = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      if (action === "assign") setMenuOpen(true);
      if (action === "close") changeRef.current(d?.conversation.status === "open" ? "closed" : "open");
    };
    window.addEventListener("relay:inbox-shortcut", onKey);
    return () => window.removeEventListener("relay:inbox-shortcut", onKey);
  }, [d?.conversation.status]);

  if (!d)
    return (
      <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-card px-4">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </header>
    );

  const c = d.conversation;
  const subtitle = [
    d.channel.name,
    d.branch?.name,
    c.kind === "group" && d.group ? members(d.group.participantCount) : null,
    c.status === "closed" ? "Closed" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const change = (
    body: { assignedUserId?: string | null; status?: "open" | "closed"; snoozedUntil?: string | null },
    done: string,
  ) =>
    update.mutate(body, {
      onSuccess: () => notify.success(done),
      onError: (err) =>
        notify.error("That didn't work", {
          description: err instanceof ApiError ? err.message : "Check your connection.",
        }),
    });
  changeRef.current = (status) =>
    d?.canWork
      ? change({ status }, status === "closed" ? "Conversation closed" : "Conversation reopened")
      : undefined;

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back to conversations"
        className="lg:hidden"
        onClick={onBack}
      >
        <Icon name="arrowLeft" />
      </Button>
      <button
        type="button"
        onClick={onDetails}
        className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {c.kind === "group" ? (
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Icon name="users" />
          </span>
        ) : (
          <Person name={c.title} size="lg" decorative className="size-9" />
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{c.title}</span>
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <Icon name={channelIcon(d.channel.type)} size="xs" className="shrink-0" />
            <span className="truncate">{subtitle}</span>
          </span>
        </span>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <TeammatesHere conversationId={c.id} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Search this conversation"
          title="Search (Ctrl F)"
          onClick={onSearch}
        >
          <Icon name="search" />
        </Button>
        {d.canWork ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                {d.assignee ? (
                  <Person name={d.assignee.name} src={d.assignee.image ?? undefined} size="xs" decorative />
                ) : (
                  <Icon name="addUser" size="sm" />
                )}
                <span className="hidden max-w-32 truncate sm:inline">
                  {d.assignee ? (d.assignee.id === me.user.id ? "You" : d.assignee.name) : "Assign"}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Who handles this conversation
              </DropdownMenuLabel>
              {d.assignee?.id !== me.user.id ? (
                <DropdownMenuItem onSelect={() => change({ assignedUserId: me.user.id }, "Assigned to you")}>
                  <Icon name="user" size="sm" />
                  Assign to me
                </DropdownMenuItem>
              ) : null}
              {d.assignee ? (
                <DropdownMenuItem onSelect={() => change({ assignedUserId: null }, "Unassigned")}>
                  <Icon name="close" size="sm" />
                  Unassign
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              {people.isPending ? (
                <div className="flex justify-center py-3">
                  <Spinner />
                </div>
              ) : (
                (people.data ?? [])
                  .filter((p) => p.id !== me.user.id)
                  .map((p) => (
                    <DropdownMenuItem
                      key={p.id}
                      onSelect={() => change({ assignedUserId: p.id }, `Assigned to ${p.name}`)}
                      className="justify-between"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Person name={p.name} src={p.image ?? undefined} size="xs" decorative />
                        <span className="truncate">{p.name}</span>
                      </span>
                      {d.assignee?.id === p.id ? <Icon name="check" size="sm" /> : null}
                    </DropdownMenuItem>
                  ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {c.kind === "direct" ? <RunAutomationButton conversationId={c.id} /> : null}
        {d.canWork && c.status === "open" ? (
          <SnoozeMenu
            snoozedUntil={c.snoozedUntil}
            busy={update.isPending}
            onSnooze={(until, label) => change({ snoozedUntil: until }, label)}
          />
        ) : null}
        {d.canWork ? (
          c.status === "open" ? (
            <Button
              ref={closeRef}
              size="sm"
              onClick={() => change({ status: "closed" }, "Conversation closed")}
              disabled={update.isPending}
            >
              <Icon name="check" />
              <span className="hidden sm:inline">Close</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => change({ status: "open" }, "Conversation reopened")}
              disabled={update.isPending}
            >
              <Icon name="refresh" />
              <span className="hidden sm:inline">Reopen</span>
            </Button>
          )
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label="Customer details" onClick={onDetails}>
          <Icon name="panelOpen" />
        </Button>
      </div>
    </header>
  );
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6" aria-hidden>
      <Skeleton className="h-10 w-2/3 rounded-lg" />
      <Skeleton className="ml-auto h-10 w-1/2 rounded-lg" />
      <Skeleton className="h-16 w-3/5 rounded-lg" />
      <Skeleton className="ml-auto h-10 w-2/5 rounded-lg" />
    </div>
  );
}

/** When the newest of these messages was sent, in ms. */
const newest = (ms: Message[]) => ms.reduce((t, m) => Math.max(t, new Date(m.sentAt).getTime()), 0);

/**
 * The scroll-down button, with how many customer messages came in while you were scrolled up (like
 * WhatsApp's). Scrolling back to the bottom, or tapping it, clears the count. Your team's own sends
 * don't count, and neither do earlier messages loaded at the top.
 */
function NewMessagesButton({ list }: { list: Message[] }) {
  const { end: scrolledUp } = useMessageScrollerScrollable();
  // The newest message you had at the bottom; anything incoming after it is new to you.
  const [seenUpTo, setSeenUpTo] = useState(() => newest(list));
  useEffect(() => {
    if (!scrolledUp) setSeenUpTo(newest(list));
  }, [scrolledUp, list]);
  const unread = scrolledUp
    ? list.filter((m) => m.direction === "inbound" && new Date(m.sentAt).getTime() > seenUpTo).length
    : 0;
  return (
    // Bottom right, like WhatsApp, with a shadow so it stands out on a dark thread.
    <MessageScrollerButton className="bottom-3 left-auto right-4 translate-x-0 overflow-visible rounded-full border shadow-md rtl:left-4 rtl:right-auto rtl:translate-x-0 sm:right-6">
      <Icon name="arrowDown" />
      <span className="sr-only">
        {unread
          ? `${unread} new ${unread === 1 ? "message" : "messages"}, scroll to the latest`
          : "Scroll to the latest"}
      </span>
      {unread ? (
        <span
          aria-hidden
          className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold tabular-nums text-primary-foreground"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </MessageScrollerButton>
  );
}

/** Teammates who also have this conversation open, so two people don't answer the same customer. */
function TeammatesHere({ conversationId }: { conversationId: string }) {
  const people = usePresence(conversationId);
  if (!people.length) return null;
  const label = `${names(people)} ${people.length === 1 ? "is" : "are"} viewing`;
  return (
    <span className="mr-1 flex items-center gap-2" title={label}>
      <span className="flex -space-x-1.5">
        {people.slice(0, 3).map((p) => (
          <Person key={p.userId} name={p.name} size="sm" decorative className="ring-2 ring-card" />
        ))}
      </span>
      <span className="hidden max-w-40 truncate text-xs text-muted-foreground xl:inline" aria-live="polite">
        {label}
      </span>
      <span className="sr-only xl:hidden">{label}</span>
    </span>
  );
}

/** "Priya is typing…" above the reply box while a teammate writes in this conversation. */
function TeammatesTyping({ conversationId }: { conversationId: string }) {
  const typing = usePresence(conversationId).filter((p) => p.typing);
  return (
    <p aria-live="polite" className="h-5 truncate px-1 text-xs text-muted-foreground">
      {typing.length ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="flex gap-0.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="size-1 animate-bounce rounded-full bg-current"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
          {names(typing)} {typing.length === 1 ? "is" : "are"} typing…
        </span>
      ) : null}
    </p>
  );
}

/** Opens the chat at the first message you hadn't seen yet, once per visit. */
function ScrollToUnread({ messageId }: { messageId: string | null }) {
  const { scrollToMessage } = useMessageScroller();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!messageId || done.current === messageId) return;
    done.current = messageId;
    // After the list has laid out.
    requestAnimationFrame(() => scrollToMessage(messageId, { align: "start", scrollMargin: 48 }));
  }, [messageId, scrollToMessage]);
  return null;
}

/** "Tue 9:00", "Today 15:30", "12 Dec 9:00". */
function whenLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round(
    (new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/** Snooze choices, in the browser's own time zone. */
function snoozeChoices() {
  const at = (days: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const nextMonday = (() => {
    const d = new Date();
    const add = (8 - d.getDay()) % 7 || 7;
    return at(add, 9);
  })();
  return [
    { label: "Later today", hint: "in 3 hours", at: new Date(Date.now() + 3 * 3600_000) },
    { label: "Tomorrow", hint: "9:00", at: at(1, 9) },
    { label: "Next week", hint: "Monday 9:00", at: nextMonday },
  ];
}

/**
 * Snooze: the conversation leaves the open lists until the chosen time, or until the customer writes
 * again. Opened with the S key too (see shortcuts.tsx).
 */
function SnoozeMenu({
  snoozedUntil,
  busy,
  onSnooze,
}: {
  snoozedUntil: string | null;
  busy: boolean;
  onSnooze: (until: string | null, done: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState("");
  useEffect(() => {
    const onKey = (e: Event) => {
      if ((e as CustomEvent<string>).detail === "snooze") setOpen(true);
    };
    window.addEventListener("relay:inbox-shortcut", onKey);
    return () => window.removeEventListener("relay:inbox-shortcut", onKey);
  }, []);
  const snooze = (at: Date) => onSnooze(at.toISOString(), `Snoozed until ${whenLabel(at.toISOString())}`);
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={busy}>
            <Icon name="clock" size="sm" />
            <span className="hidden max-w-36 truncate sm:inline">
              {snoozedUntil ? `Snoozed · ${whenLabel(snoozedUntil)}` : "Snooze"}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Hide until later. It comes back sooner if the customer writes.
          </DropdownMenuLabel>
          {snoozeChoices().map((choice) => (
            <DropdownMenuItem
              key={choice.label}
              onSelect={() => snooze(choice.at)}
              className="justify-between"
            >
              {choice.label}
              <span className="text-xs text-muted-foreground">{choice.hint}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setPicking(true)}>Pick a date and time…</DropdownMenuItem>
          {snoozedUntil ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onSnooze(null, "Unsnoozed")}>
                <Icon name="close" size="sm" />
                Unsnooze
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Modal
        open={picking}
        onOpenChange={setPicking}
        size="sm"
        title="Snooze until"
        description="The conversation comes back at this time, or sooner if the customer writes."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const at = new Date(custom);
            if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) {
              notify.error("Pick a time in the future");
              return;
            }
            snooze(at);
            setPicking(false);
          }}
        >
          <TextInput
            type="datetime-local"
            aria-label="Date and time"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            required
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button type="submit">Snooze</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
