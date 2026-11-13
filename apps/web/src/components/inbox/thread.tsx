"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { Icon } from "@relay/ui/components/icon";
import { Person } from "@relay/ui/components/person";
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
} from "@relay/ui/ui/message-scroller";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Spinner } from "@relay/ui/ui/spinner";
import { type DragEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { channelIcon } from "./conversation-list";
import { DetailsPanel } from "./details-panel";
import { dayLabel, members } from "./format";
import { MessageBubble } from "./message-bubble";
import {
  useAssignees,
  useConversation,
  useMarkRead,
  useMessages,
  useRetry,
  useUpdateConversation,
} from "./queries";
import type { ConversationDetail, Message } from "./types";

type Props = { id: string; onBack: () => void; className?: string };

export function Thread({ id, onBack, className }: Props) {
  const detail = useConversation(id);
  const messages = useMessages(id);
  const markRead = useMarkRead();
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [dropped, setDropped] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [details, setDetails] = useState(false);

  const list = useMemo(
    () => (messages.data ? [...messages.data.pages].reverse().flatMap((p) => p.messages) : []),
    [messages.data],
  );
  const newestInbound = [...list].reverse().find((m) => m.direction === "inbound")?.id;

  // Opening a conversation, and every new customer message while it is open, marks it read for you.
  // biome-ignore lint/correctness/useExhaustiveDependencies: markRead is stable enough; run on id or new inbound
  useEffect(() => {
    if (id && document.visibilityState === "visible") markRead.mutate(id);
  }, [id, newestInbound]);

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
          <Button variant="outline" size="sm" onClick={onBack} className="md:hidden">
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
      <ThreadHeader detail={d} onBack={onBack} onDetails={() => setDetails(true)} />

      <div className="relative min-h-0 flex-1">
        {messages.isPending || !d ? (
          <ThreadSkeleton />
        ) : (
          <MessageScrollerProvider key={id} autoScroll defaultScrollPosition="end">
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
                    detail={d}
                    onReply={d.canWork && d.conversation.windowOpen ? setReplyTo : undefined}
                  />
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton className="bottom-3" />
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
  detail,
  onReply,
}: {
  list: Message[];
  detail: ConversationDetail;
  onReply?: (m: Message) => void;
}) {
  const retry = useRetry(detail.conversation.id);
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
        No messages yet. When the customer writes, it shows up here.
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
        {newDay ? (
          <Marker variant="separator" className="py-3 text-xs">
            <MarkerContent>{dayLabel(m.sentAt)}</MarkerContent>
          </Marker>
        ) : null}
        <MessageScrollerItem messageId={m.id} className={cn(first ? "pt-3" : "pt-1")}>
          <MessageBubble
            message={m}
            first={first}
            last={last}
            isGroup={isGroup}
            onReply={onReply}
            onRetry={canRetry ? onRetry : undefined}
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
}: {
  detail: ConversationDetail | undefined;
  onBack: () => void;
  onDetails: () => void;
}) {
  const update = useUpdateConversation(d?.conversation.id ?? "");
  const { me } = useMe();
  const [menuOpen, setMenuOpen] = useState(false);
  const people = useAssignees(d?.conversation.id ?? "", !!d && menuOpen);
  const closeRef = useRef<HTMLButtonElement>(null);

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

  const change = (body: { assignedUserId?: string | null; status?: "open" | "closed" }, done: string) =>
    update.mutate(body, {
      onSuccess: () => notify.success(done),
      onError: (err) =>
        notify.error("That didn't work", {
          description: err instanceof ApiError ? err.message : "Check your connection.",
        }),
    });

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back to conversations"
        className="md:hidden"
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
