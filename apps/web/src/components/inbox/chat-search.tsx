"use client";

import { Icon } from "@relay/ui/components/icon";
import { SearchInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import { useMessageScroller } from "@relay/ui/ui/message-scroller";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { clockTime } from "./format";
import type { Message } from "./types";

/*
 * Search inside the open conversation, across its whole history. Matches come newest first; ↑ goes to
 * older ones, ↓ to newer. A match that isn't loaded yet is fetched by loading older pages (up to
 * MAX_PAGES); beyond that the bar shows the matching text instead of jumping.
 */

type Match = { id: string; sentAt: string; snippet: string };
const MAX_PAGES = 20;

export function ChatSearch({
  conversationId,
  list,
  loadOlder,
  onHighlight,
  onClose,
}: {
  conversationId: string;
  list: Message[];
  /** Loads one older page; resolves false when there is nothing older. */
  loadOlder: () => Promise<boolean>;
  onHighlight: (id: string | null) => void;
  onClose: () => void;
}) {
  const { scrollToMessage } = useMessageScroller();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const [far, setFar] = useState<Match | null>(null);
  const [jumping, setJumping] = useState(false);
  const latest = useRef(list);
  latest.current = list;

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const search = useQuery({
    queryKey: ["inbox", "search", conversationId, q],
    queryFn: () =>
      api<{ matches: Match[] }>(
        `/conversations/${conversationId}/messages/search?q=${encodeURIComponent(q)}`,
      ).then((r) => r.matches),
    enabled: q.length >= 2,
    staleTime: 10_000,
  });
  const matches = search.data ?? [];
  const current = matches[Math.min(index, matches.length - 1)];

  // biome-ignore lint/correctness/useExhaustiveDependencies: jump when the chosen match changes
  useEffect(() => {
    setIndex(0);
  }, [q]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: list and loadOlder are read through refs
  useEffect(() => {
    if (!current) {
      onHighlight(null);
      setFar(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setFar(null);
      setJumping(true);
      for (let page = 0; !latest.current.some((m) => m.id === current.id); page++) {
        if (page >= MAX_PAGES || !(await loadOlder())) break;
        // Let the new page render before looking again.
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        if (cancelled) return;
      }
      if (cancelled) return;
      setJumping(false);
      if (latest.current.some((m) => m.id === current.id)) {
        onHighlight(current.id);
        requestAnimationFrame(() => scrollToMessage(current.id, { align: "center" }));
      } else {
        onHighlight(null);
        setFar(current);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.id]);

  const move = (step: 1 | -1) => {
    if (!matches.length) return;
    setIndex((i) => (i + step + matches.length) % matches.length);
  };

  return (
    <div className="absolute inset-x-0 top-0 z-20 border-b bg-card/95 px-3 py-2 backdrop-blur sm:px-4">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <SearchInput
          autoFocus
          aria-label="Search this conversation"
          placeholder="Search this conversation"
          value={text}
          onValueChange={setText}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              move(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="flex-1"
        />
        <span className="min-w-16 text-right text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {q.length < 2
            ? ""
            : search.isPending || jumping
              ? "Searching…"
              : matches.length
                ? `${index + 1} of ${matches.length}${matches.length === 50 ? "+" : ""}`
                : "No matches"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Older match"
          disabled={!matches.length}
          onClick={() => move(1)}
        >
          <Icon name="chevronUp" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Newer match"
          disabled={!matches.length}
          onClick={() => move(-1)}
        >
          <Icon name="chevronDown" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close search" onClick={onClose}>
          <Icon name="close" />
        </Button>
      </div>
      {far ? (
        <p className="mx-auto mt-1.5 max-w-3xl truncate text-xs text-muted-foreground">
          Too far back to jump to · {clockTime(far.sentAt)} · {far.snippet}
        </p>
      ) : null}
    </div>
  );
}
