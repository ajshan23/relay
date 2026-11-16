"use client";

import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ApiError, api } from "@/lib/api";
import type {
  ChannelSummary,
  ConversationDetail,
  ConversationPage,
  Counts,
  InboxView,
  Message,
  MessagePage,
  Person,
  Upload,
} from "./types";

/*
 * Every inbox read and write. Query keys start with "inbox" so live events can refresh them in one
 * place (live.tsx). Lists and history are paged; sending shows the message straight away.
 */

export const keys = {
  all: ["inbox"] as const,
  lists: () => ["inbox", "list"] as const,
  list: (f: ListFilter) => ["inbox", "list", f] as const,
  counts: (branch: string) => ["inbox", "counts", branch] as const,
  detail: (id: string) => ["inbox", "detail", id] as const,
  messages: (id: string) => ["inbox", "messages", id] as const,
  assignees: (id: string) => ["inbox", "assignees", id] as const,
  channels: () => ["inbox", "channels"] as const,
};

export type ListFilter = { view: InboxView; channel: string | null; q: string; branch: string };

const qs = (params: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : "";
};

export function useConversations(filter: ListFilter) {
  return useInfiniteQuery({
    queryKey: keys.list(filter),
    queryFn: ({ pageParam }) =>
      api<ConversationPage>(
        `/conversations${qs({ view: filter.view, channel: filter.channel, q: filter.q, branch: filter.branch, cursor: pageParam })}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useCounts(branch: string) {
  return useQuery({
    queryKey: keys.counts(branch),
    queryFn: () => api<Counts>(`/conversations/counts${qs({ branch })}`),
  });
}

export function useChannels() {
  return useQuery({
    queryKey: keys.channels(),
    queryFn: () => api<{ channels: ChannelSummary[] }>("/channels").then((r) => r.channels),
    staleTime: 60_000,
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: keys.detail(id ?? ""),
    queryFn: () => api<ConversationDetail>(`/conversations/${id}`),
    enabled: !!id,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
}

export function useMessages(id: string | null) {
  return useInfiniteQuery({
    queryKey: keys.messages(id ?? ""),
    queryFn: ({ pageParam }) => api<MessagePage>(`/conversations/${id}/messages${qs({ before: pageParam })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: !!id,
  });
}

/** The history endpoint's page size (newest page first). */
const HISTORY_PAGE = 50;

const order = (a: Message, b: Message) =>
  a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const refreshing = new Set<string>();
const refreshAgain = new Set<string>();

/**
 * Brings an open chat up to date with one request: its newest page is fetched and merged into what's
 * already on screen (new messages added, changed ones replaced), however far back you scrolled. A plain
 * refetch would reload every page loaded so far, one after another. Falls back to that only when more
 * than a page arrived at once, or when `messageIds` changed but aren't among the newest.
 */
export async function refreshNewest(qc: QueryClient, id: string, messageIds: string[] = []): Promise<void> {
  const key = keys.messages(id);
  if (!qc.getQueryData<InfiniteData<MessagePage>>(key)) return; // not open here: nothing to update
  if (refreshing.has(id)) {
    refreshAgain.add(id);
    return;
  }
  refreshing.add(id);
  try {
    const fresh = await api<MessagePage>(`/conversations/${id}/messages`);
    const freshIds = new Set(fresh.messages.map((m) => m.id));
    let fallBack = false;
    qc.setQueryData<InfiniteData<MessagePage>>(key, (data) => {
      const first = data?.pages[0];
      if (!data || !first) return data;
      const known = first.messages.filter((m) => !m.pending);
      // A full page of only new messages: there may be more between them and what's on screen.
      if (fresh.messages.length >= HISTORY_PAGE && known.length && !known.some((m) => freshIds.has(m.id))) {
        fallBack = true;
        return data;
      }
      const older = data.pages.slice(1).flatMap((p) => p.messages);
      if (messageIds.some((m) => !freshIds.has(m) && older.some((o) => o.id === m))) {
        fallBack = true;
        return data;
      }
      // The newest page is the truth for its own time span: anything there that it no longer has (a
      // deleted note) goes. Older messages on screen stay; stand-ins still sending stay until confirmed.
      const oldestFresh = fresh.messages[0];
      // (No older messages at all when the newest page is the whole history.)
      const keep = (m: Message) =>
        !freshIds.has(m.id) &&
        (!!m.pending || (fresh.nextBefore !== null && !!oldestFresh && order(m, oldestFresh) < 0));
      const merged = [...first.messages.filter(keep), ...fresh.messages].sort(order);
      return {
        ...data,
        pages: [
          { ...first, messages: merged },
          ...data.pages
            .slice(1)
            .map((p) => ({ ...p, messages: p.messages.filter((m) => !freshIds.has(m.id)) })),
        ],
      };
    });
    if (fallBack) await qc.invalidateQueries({ queryKey: key });
  } catch {
    await qc.invalidateQueries({ queryKey: key });
  } finally {
    refreshing.delete(id);
    if (refreshAgain.delete(id)) void refreshNewest(qc, id);
  }
}

export function useAssignees(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.assignees(id),
    queryFn: () => api<{ users: Person[] }>(`/conversations/${id}/assignees`).then((r) => r.users),
    enabled,
    staleTime: 60_000,
  });
}

export function useUpdateConversation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      assignedUserId?: string | null;
      status?: "open" | "closed";
      snoozedUntil?: string | null;
    }) => api(`/conversations/${id}`, { method: "PATCH", json: body }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

/** A real word: 3+ letters or digits in a row (any script), or two words. A lone "a" isn't typing a reply. */
const hasWord = (text: string) => /[\p{L}\p{N}]{3,}/u.test(text) || /\S\s+\S/.test(text.trim());

/** WhatsApp shows "typing…" for up to 25 s; while someone keeps typing, renew it this often. */
const TYPING_RENEW_MS = 20_000;

/**
 * Call with the reply box's text on every keystroke. Tells the customer's app "typing…":
 *   - only once there's a real word, so a stray letter never shows it;
 *   - right away for a new reply (after a send, or once the box was emptied), then renewed every 20 s
 *     only while keys are still being pressed, so it stops as soon as the person stops typing.
 * WhatsApp decides how long it stays visible (until our reply arrives, at most 25 s); there's no way to
 * shorten that, so the trigger is what we keep careful. The server checks the window and the channel.
 */
export function useTypingSignal(id: string) {
  const sentAt = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new conversation starts its own clock
  useEffect(() => {
    sentAt.current = 0;
  }, [id]);
  return (text: string) => {
    // An empty box means the reply was sent or cleared: the next one signals afresh.
    if (!text.trim()) {
      sentAt.current = 0;
      return;
    }
    if (!hasWord(text)) return;
    const now = Date.now();
    if (now - sentAt.current < TYPING_RENEW_MS) return;
    sentAt.current = now;
    void api(`/conversations/${id}/typing`, { method: "POST" }).catch(() => undefined);
  };
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ previousReadAt: string | null }>(`/conversations/${id}/read`, { method: "POST" }),
    onMutate: (id) => {
      // Clear the badge at once; the server confirms with a live event.
      qc.setQueriesData<InfiniteData<ConversationPage>>({ queryKey: keys.lists() }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({
                ...p,
                conversations: p.conversations.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)),
              })),
            }
          : data,
      );
    },
  });
}

export function upload(conversationId: string, file: File) {
  const form = new FormData();
  form.set("conversationId", conversationId);
  form.set("file", file);
  return api<{ upload: Upload }>("/uploads", { method: "POST", body: form }).then((r) => r.upload);
}

type SendInput = {
  text?: string;
  upload?: Upload;
  replyToMessageId?: string;
  senderName: string;
  /** A ready template with its detail values; `rendered` is shown until the server confirms. */
  template?: {
    id: string;
    values: Record<string, string>;
    rendered: { header: string | null; body: string; footer: string | null; buttons: { text: string }[] };
  };
};

export function useSend(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ text, upload, replyToMessageId, template }: SendInput) =>
      api<{ message: { id: string } }>(`/conversations/${conversationId}/messages`, {
        method: "POST",
        json: {
          text: text || undefined,
          uploadId: upload?.id,
          voice: upload?.voice || undefined,
          replyToMessageId,
          templateId: template?.id,
          values: template?.values,
        },
      }),
    // The message appears at once with a clock; the real one replaces it when the history refreshes.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.messages(conversationId) });
      const temp: Message = {
        id: `pending-${Date.now()}`,
        direction: "outbound",
        senderType: "user",
        sender: { kind: "user", id: null, name: input.senderName },
        type: input.template ? "template" : (input.upload?.kind ?? "text"),
        content: input.template
          ? {
              type: "template",
              header: input.template.rendered.header
                ? { kind: "text", text: input.template.rendered.header }
                : null,
              body: input.template.rendered.body,
              footer: input.template.rendered.footer,
              buttons: input.template.rendered.buttons,
            }
          : input.upload
            ? { type: input.upload.kind, caption: input.text ?? null }
            : { type: "text", text: input.text },
        status: "queued",
        error: null,
        sentAt: new Date().toISOString(),
        deliveredAt: null,
        readAt: null,
        attachments: input.upload
          ? [
              {
                id: input.upload.id,
                kind: input.upload.kind,
                mimeType: input.upload.mimeType,
                fileName: input.upload.fileName,
                sizeBytes: input.upload.sizeBytes,
                status: "stored",
                url: input.upload.url,
              },
            ]
          : [],
        reactions: [],
        replyTo: null,
        receipts: null,
        pending: true,
      };
      qc.setQueryData<InfiniteData<MessagePage>>(keys.messages(conversationId), (data) => {
        if (!data?.pages.length) return data;
        const [first, ...rest] = data.pages;
        return first
          ? { ...data, pages: [{ ...first, messages: [...first.messages, temp] }, ...rest] }
          : data;
      });
      // The chat jumps to the top of the list with this message as its preview, before the server says so.
      const preview = {
        type: temp.type,
        text: input.template?.rendered.body ?? input.text ?? input.upload?.fileName ?? null,
        direction: "outbound" as const,
        senderName: input.senderName,
      };
      qc.setQueriesData<InfiniteData<ConversationPage>>({ queryKey: keys.lists() }, (data) => {
        if (!data?.pages.length) return data;
        const row = data.pages.flatMap((p) => p.conversations).find((c) => c.id === conversationId);
        if (!row) return data;
        const moved = { ...row, preview, activityAt: temp.sentAt };
        return {
          ...data,
          pages: data.pages.map((p, i) => ({
            ...p,
            conversations: [
              ...(i === 0 ? [moved] : []),
              ...p.conversations.filter((c) => c.id !== conversationId),
            ],
          })),
        };
      });
      return { tempId: temp.id };
    },
    // The server gave it its real id: the next refresh replaces it in place instead of adding a copy.
    onSuccess: (res, _input, ctx) => {
      qc.setQueryData<InfiniteData<MessagePage>>(keys.messages(conversationId), (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({
                ...p,
                // If a live refresh already brought the real one, drop the stand-in instead.
                messages: data.pages.some((q) => q.messages.some((m) => m.id === res.message.id))
                  ? p.messages.filter((m) => m.id !== ctx?.tempId)
                  : p.messages.map((m) => (m.id === ctx?.tempId ? { ...m, id: res.message.id } : m)),
              })),
            }
          : data,
      );
    },
    onError: (_err, _input, ctx) => {
      qc.setQueryData<InfiniteData<MessagePage>>(keys.messages(conversationId), (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({
                ...p,
                messages: p.messages.filter((m) => m.id !== ctx?.tempId),
              })),
            }
          : data,
      );
    },
    onSettled: () => {
      void refreshNewest(qc, conversationId);
      void qc.invalidateQueries({ queryKey: keys.lists() });
    },
  });
}

export function useRetry(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, confirm }: { messageId: string; confirm?: boolean }) =>
      api(`/conversations/${conversationId}/messages/${messageId}/retry`, {
        method: "POST",
        json: { confirm: !!confirm },
      }),
    onSettled: () => refreshNewest(qc, conversationId),
  });
}

/** Reacts to a message with an emoji, or takes our reaction away with "". */
export function useReact(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      api(`/conversations/${conversationId}/messages/${messageId}/react`, {
        method: "POST",
        json: { emoji },
      }),
    onSettled: () => refreshNewest(qc, conversationId),
  });
}

/** Adds an internal note (team only). `text` carries mentions as "@[Name](userId)". */
export function useAddNote(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      api<{ note: { id: string } }>(`/conversations/${conversationId}/notes`, {
        method: "POST",
        json: { text },
      }),
    onSettled: () => refreshNewest(qc, conversationId),
  });
}

export function useDeleteNote(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) =>
      api(`/conversations/${conversationId}/notes/${noteId}`, { method: "DELETE" }),
    onSettled: () => refreshNewest(qc, conversationId),
  });
}
