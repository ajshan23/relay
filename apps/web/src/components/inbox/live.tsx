"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { keys } from "./queries";

/*
 * Data for the signed-in app, plus live updates from /api/events.
 * Events are hints ("conversation X changed"); this refreshes the matching queries, a few at a time,
 * so a burst of webhooks causes one refetch, not fifty. After a reconnect everything is refreshed,
 * since events sent while offline are lost.
 */

type Hint = { type: string; conversationId: string; messageId?: string; userId?: string };

function LiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let everConnected = false;
    let stopped = false;
    const changed = new Set<string>();
    const lists = { stale: false };

    const flush = () => {
      timer = undefined;
      if (lists.stale) {
        lists.stale = false;
        void qc.invalidateQueries({ queryKey: keys.lists() });
        void qc.invalidateQueries({ queryKey: ["inbox", "counts"] });
      }
      for (const id of changed) {
        void qc.invalidateQueries({ queryKey: keys.messages(id) });
        void qc.invalidateQueries({ queryKey: keys.detail(id) });
      }
      changed.clear();
    };
    const schedule = () => {
      timer ??= setTimeout(flush, 150);
    };

    const onHint = (e: MessageEvent<string>) => {
      try {
        const hint = JSON.parse(e.data) as Hint;
        if (hint.type !== "conversation.read") changed.add(hint.conversationId);
        if (hint.type !== "message.updated") lists.stale = true;
        schedule();
      } catch {
        // Ignore a malformed hint.
      }
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource("/api/events");
      source.addEventListener("ready", () => {
        if (everConnected) void qc.invalidateQueries({ queryKey: keys.all });
        everConnected = true;
      });
      for (const type of ["conversation.updated", "message.updated", "conversation.read"])
        source.addEventListener(type, onHint as EventListener);
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
  }, [qc]);
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
  return (
    <QueryClientProvider client={client}>
      <LiveUpdates />
      {children}
    </QueryClientProvider>
  );
}
