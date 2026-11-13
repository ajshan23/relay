"use client";

import { Icon } from "@relay/ui/components/icon";
import { Switch } from "@relay/ui/ui/switch";
import { channelIcon } from "@/components/inbox/conversation-list";
import { Chip } from "./cells";
import type { ContactsMeta } from "./queries";

type Channel = ContactsMeta["channels"][number];

/**
 * Whether a contact gets marketing: everywhere, nowhere ("all channels" opt-out), or everywhere except
 * the channels they opted out of. Service messages (replies, reminders) are never affected.
 */
export function MarketingStatus({ optOuts, channels }: { optOuts: (string | null)[]; channels: Channel[] }) {
  if (!optOuts.length) return <Chip colour="green">Subscribed</Chip>;
  if (optOuts.includes(null)) return <Chip colour="red">Opted out</Chip>;
  const names = optOuts.map((id) => channels.find((c) => c.id === id)?.name ?? "a removed channel");
  return (
    <span title={`Opted out on ${names.join(", ")}`}>
      <Chip colour="amber">
        {names.length === 1 ? `Opted out on ${names[0]}` : `Opted out on ${names.length} channels`}
      </Chip>
    </span>
  );
}

const sourceText: Record<string, string> = {
  reply: "they replied STOP",
  manual: "set by your team",
  import: "from an import",
};

/** A switch for every channel, plus one for all channels at once. On means they get marketing there. */
export function MarketingEditor({
  optOuts,
  channels,
  canEdit,
  onChange,
  sources,
}: {
  optOuts: (string | null)[];
  channels: Channel[];
  canEdit: boolean;
  onChange: (channelAccountId: string | null, optedOut: boolean) => void;
  /** Why each opt-out exists, when known (the profile has it, the table doesn't). */
  sources?: { channelAccountId: string | null; source: string }[];
}) {
  const all = optOuts.includes(null);
  const why = (id: string | null) => {
    const s = sources?.find((x) => x.channelAccountId === id)?.source;
    return s ? sourceText[s] : null;
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1">
        <span className="min-w-0">
          <span className="block text-sm font-medium">All channels</span>
          <span className="block text-xs text-muted-foreground">
            {all
              ? `Opted out everywhere${why(null) ? `, ${why(null)}` : ""}`
              : "Turn off to stop all marketing"}
          </span>
        </span>
        <Switch
          checked={!all}
          disabled={!canEdit}
          onCheckedChange={(on) => onChange(null, !on)}
          aria-label="Marketing on all channels"
        />
      </label>
      {channels.length ? <div className="my-1 border-t" /> : null}
      {channels.map((c) => {
        const out = optOuts.includes(c.id);
        return (
          <label key={c.id} className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1">
            <span className="flex min-w-0 items-center gap-2">
              <Icon name={channelIcon(c.type)} size="sm" className="shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm">{c.name}</span>
                {out && why(c.id) ? (
                  <span className="block text-xs text-muted-foreground">Opted out, {why(c.id)}</span>
                ) : null}
              </span>
            </span>
            <Switch
              checked={!all && !out}
              disabled={!canEdit || all}
              onCheckedChange={(on) => onChange(c.id, !on)}
              aria-label={`Marketing on ${c.name}`}
            />
          </label>
        );
      })}
      <p className="px-1.5 pt-1 text-xs text-muted-foreground">
        Replies and reminders still go out. Only broadcasts and promotions stop.
      </p>
    </div>
  );
}
