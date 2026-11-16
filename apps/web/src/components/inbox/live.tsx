"use client";

import { notify } from "@relay/ui/components/toast";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useBranch } from "@/components/shell/branch-context";
import { applyPresence } from "./presence";
import { keys, refreshNewest } from "./queries";

/*
 * Data for the signed-in app, plus live updates from /api/events.
 * Events are hints ("conversation X changed"); this refreshes the matching queries, a few at a time,
 * so a burst of webhooks causes one refetch, not fifty. After a reconnect everything is refreshed,
 * since events sent while offline are lost. The stream carries only the selected branch's events and
 * reconnects when the branch changes. A delivery receipt (message.updated) refreshes only that
 * conversation's messages, never the lists or counts.
 */

type Hint = { type: string; conversationId: string; messageId?: string; userId?: string };

/** Rendered inside BranchProvider (see the app layout). */
export function LiveUpdates() {
  const qc = useQueryClient();
  const branchId = useBranch().branch.id;
  useEffect(() => {
    if (!branchId) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let everConnected = false;
    let stopped = false;
    const changed = new Set<string>();
    /** Messages a "message.updated" named, per conversation (to check they were refreshed). */
    const changedMessages = new Map<string, string[]>();
    const lists = { stale: false };

    const flush = () => {
      timer = undefined;
      if (lists.stale) {
        lists.stale = false;
        void qc.invalidateQueries({ queryKey: keys.lists() });
        void qc.invalidateQueries({ queryKey: ["inbox", "counts"] });
      }
      for (const id of changed) {
        // The open chat: only its newest messages are fetched and merged in (one small request).
        void refreshNewest(qc, id, changedMessages.get(id));
        void qc.invalidateQueries({ queryKey: keys.detail(id) });
        // The "automation is running" bar over the chat (an automation can start or end any time).
        void qc.invalidateQueries({ queryKey: ["automations", branchId, "chat", id] });
      }
      changed.clear();
      changedMessages.clear();
    };
    const schedule = () => {
      // Short enough to feel instant, long enough that a burst of webhooks makes one refresh.
      timer ??= setTimeout(flush, 50);
    };

    const onTemplate = () => {
      void qc.invalidateQueries({ queryKey: ["templates"] });
    };
    const onHint = (e: MessageEvent<string>) => {
      try {
        const hint = JSON.parse(e.data) as Hint;
        if (hint.type !== "conversation.read") changed.add(hint.conversationId);
        if (hint.messageId)
          changedMessages.set(hint.conversationId, [
            ...(changedMessages.get(hint.conversationId) ?? []),
            hint.messageId,
          ]);
        if (hint.type !== "message.updated") lists.stale = true;
        schedule();
      } catch {
        // Ignore a malformed hint.
      }
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource(`/api/events?branch=${encodeURIComponent(branchId)}`);
      source.addEventListener("ready", () => {
        if (everConnected) void qc.invalidateQueries({ queryKey: keys.all });
        everConnected = true;
      });
      for (const type of ["conversation.updated", "message.updated", "conversation.read"])
        source.addEventListener(type, onHint as EventListener);
      source.addEventListener("template.updated", onTemplate);
      // Someone @mentioned you in a note (the stream only sends you your own).
      source.addEventListener("mention", ((e: MessageEvent<string>) => {
        try {
          const m = JSON.parse(e.data) as { conversationId: string; byName: string };
          void qc.invalidateQueries({ queryKey: ["inbox", "counts"] });
          void qc.invalidateQueries({ queryKey: keys.lists() });
          notify.info(`${m.byName} mentioned you in a note`, {
            action: {
              label: "Open",
              onClick: () => {
                window.location.href = `/conversations?view=mentions&c=${encodeURIComponent(m.conversationId)}`;
              },
            },
          });
        } catch {
          // Ignore a malformed hint.
        }
      }) as EventListener);
      // Teammates viewing or typing: shown in the open conversation only, never a refetch.
      source.addEventListener("presence", ((e: MessageEvent<string>) => {
        try {
          applyPresence(JSON.parse(e.data));
        } catch {
          // Ignore a malformed hint.
        }
      }) as EventListener);
      source.onerror = () => {
        // The browser retries on its own unless the stream was refused (closed); then retry later.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retry = setTimeout(connect, 5_000);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(timer);
      clearTimeout(retry);
    };
  }, [qc, branchId]);
  return null;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
