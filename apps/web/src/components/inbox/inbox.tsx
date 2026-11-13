"use client";

import { Icon } from "@relay/ui/components/icon";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@relay/ui/ui/empty";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useBranch } from "@/components/shell/branch-context";
import { cn } from "@/lib/utils";
import { ConversationList } from "./conversation-list";
import type { ListFilter } from "./queries";
import { Thread } from "./thread";
import type { InboxView } from "./types";

const views: InboxView[] = ["open", "mine", "unassigned", "closed"];

/**
 * The inbox: the approved Board layout, two panes (chat list + conversation) with details in the
 * side panel. State lives in the URL: ?view=&channel=&c=. On a phone the list and the conversation
 * take turns filling the screen.
 */
export function Inbox() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { branch } = useBranch();
  const [q, setQ] = useState("");

  const rawView = params.get("view");
  const view = views.includes(rawView as InboxView) ? (rawView as InboxView) : "open";
  const channel = params.get("channel");
  const selected = params.get("c");

  const filter = useMemo<ListFilter>(
    () => ({ view, channel, q, branch: branch.id }),
    [view, channel, q, branch.id],
  );

  const setParams = useCallback(
    (next: Record<string, string | null>) => {
      const s = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v) s.set(k, v);
        else s.delete(k);
      }
      router.replace(`${pathname}?${s.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  return (
    <div className="flex h-full min-h-0">
      <ConversationList
        filter={filter}
        selectedId={selected}
        onSelect={(id) => setParams({ c: id })}
        onViewChange={(v) => setParams({ view: v === "open" ? null : v })}
        onSearch={setQ}
        className={cn("w-full border-r md:w-[340px] md:shrink-0 lg:w-[360px]", selected && "hidden md:flex")}
      />
      {selected ? (
        <Thread id={selected} onBack={() => setParams({ c: null })} className="flex-1" />
      ) : (
        <div className="hidden flex-1 items-center justify-center md:flex">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="conversations" />
              </EmptyMedia>
              <EmptyTitle>Pick a conversation</EmptyTitle>
              <EmptyDescription>Choose a chat on the left to read it and reply.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      )}
    </div>
  );
}
