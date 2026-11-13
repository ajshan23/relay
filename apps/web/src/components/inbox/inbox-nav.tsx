"use client";

import { Icon } from "@relay/ui/components/icon";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useBranch } from "@/components/shell/branch-context";
import type { Section } from "@/components/shell/nav-config";
import { cn } from "@/lib/utils";
import { channelIcon } from "./conversation-list";
import { useChannels, useCounts } from "./queries";
import type { Counts } from "./types";

/**
 * The sidebar sub-menu for Conversations: the views with live counts, then every connected channel
 * of the business (several numbers of one type each get their own row).
 */
export function InboxNav({
  section,
  itemClass,
}: {
  section: Section;
  itemClass: (active: boolean) => string;
}) {
  const params = useSearchParams();
  const { branch } = useBranch();
  const counts = useCounts(branch.id);
  const channels = useChannels();
  const view = params.get("view") ?? "open";
  const channel = params.get("channel");

  const href = (next: { view?: string; channel?: string | null }) => {
    const s = new URLSearchParams();
    const v = next.view ?? view;
    if (v !== "open") s.set("view", v);
    const ch = next.channel === undefined ? channel : next.channel;
    if (ch) s.set("channel", ch);
    const out = s.toString();
    return `/conversations${out ? `?${out}` : ""}`;
  };

  const items = section.groups[0]?.items ?? [];
  return (
    <>
      <div className="flex flex-col gap-px">
        <p className="mb-0.5 px-2 text-xs text-nav-muted">Conversations</p>
        {items.map((t) => {
          const n = counts.data?.[t.view as keyof Counts];
          const active = view === t.view;
          return (
            <Link
              key={t.view}
              href={href({ view: t.view })}
              aria-current={active ? "page" : undefined}
              className={itemClass(active)}
            >
              <span className="flex-1 truncate">{t.label}</span>
              {n ? <span className="text-xs text-nav-muted tabular-nums">{n}</span> : null}
            </Link>
          );
        })}
      </div>
      <div className="mt-4 flex flex-col gap-px">
        <p className="mb-0.5 px-2 text-xs text-nav-muted">Channels</p>
        <Link
          href={href({ channel: null })}
          aria-current={!channel ? "page" : undefined}
          className={itemClass(!channel)}
        >
          <span className="truncate">All channels</span>
        </Link>
        {(channels.data ?? [])
          .filter((c) => c.defaultBranchId === branch.id)
          .map((c) => (
            <Link
              key={c.id}
              href={href({ channel: c.id })}
              aria-current={channel === c.id ? "page" : undefined}
              className={cn(itemClass(channel === c.id), c.status !== "active" && "opacity-60")}
              title={c.displayPhone ?? undefined}
            >
              <Icon name={channelIcon(c.type)} size="xs" className="shrink-0" />
              <span className="truncate">{c.displayName}</span>
            </Link>
          ))}
        {channels.data && !channels.data.length ? (
          <p className="px-2 py-1 text-xs text-nav-muted">No channels connected</p>
        ) : null}
      </div>
    </>
  );
}
