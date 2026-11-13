"use client";

import {
  type InfiniteData,
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
    mutationFn: (body: { assignedUserId?: string | null; status?: "open" | "closed" }) =>
      api(`/conversations/${id}`, { method: "PATCH", json: body }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

/**
 * Call on every keystroke in the reply box: tells the customer's app "typing…", at most once every
 * 20 s (WhatsApp shows it for 25 s). The server checks the window, the channel and its setting.
 */
export function useTypingSignal(id: string) {
  const last = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new conversation starts its own clock
  useEffect(() => {
    last.current = 0;
  }, [id]);
  return () => {
    const now = Date.now();
    if (now - last.current < 20_000) return;
    last.current = now;
    void api(`/conversations/${id}/typing`, { method: "POST" }).catch(() => undefined);
  };
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/conversations/${id}/read`, { method: "POST" }),
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
      return { tempId: temp.id };
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
      void qc.invalidateQueries({ queryKey: keys.messages(conversationId) });
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
    onSettled: () => qc.invalidateQueries({ queryKey: keys.messages(conversationId) }),
  });
}
