import { Icon, type IconName } from "@relay/ui/components/icon";
import { cn } from "@relay/ui/lib/utils";
import { AppWindow, Avatar, IconRail } from "./parts";

/* Slide 1: the inbox, where Mira hands a billing question to a person. */

type Channel = "whatsapp" | "instagram" | "website";

type Row = {
  name: string;
  initials: string;
  tint: string;
  channel: Channel;
  preview: string;
  time: string;
  state: "mira" | "needs-you" | "handled";
  unread?: number;
  selected?: boolean;
};

const rows: Row[] = [
  {
    name: "Omar Saleh",
    initials: "OS",
    tint: "bg-[#fde7d9] text-[#9a3d0b]",
    channel: "instagram",
    preview: "I think I was charged twice for my last visit",
    time: "9:44",
    state: "needs-you",
    unread: 2,
    selected: true,
  },
  {
    name: "Hana Yousef",
    initials: "HY",
    tint: "bg-[#dcf2ea] text-[#0b6b52]",
    channel: "whatsapp",
    preview: "You're booked for 9:30 tomorrow",
    time: "9:41",
    state: "mira",
  },
  {
    name: "Priya Nair",
    initials: "PN",
    tint: "bg-[#e3e8fd] text-[#2f42a3]",
    channel: "website",
    preview: "Yes, we're open Fridays from 9 to 6",
    time: "9:38",
    state: "mira",
  },
  {
    name: "Sofia Rossi",
    initials: "SR",
    tint: "bg-[#fbe3ef] text-[#9b1e5c]",
    channel: "whatsapp",
    preview: "Can I move my appointment to Monday?",
    time: "9:12",
    state: "needs-you",
    unread: 1,
  },
  {
    name: "Ahmed Khan",
    initials: "AK",
    tint: "bg-[#efe9dc] text-[#6b5313]",
    channel: "whatsapp",
    preview: "Thanks, see you then!",
    time: "9:05",
    state: "handled",
  },
];

const channelIcon: Record<Channel, IconName> = {
  whatsapp: "whatsapp",
  instagram: "instagram",
  website: "website",
};

function StateTag({ state }: { state: Row["state"] }) {
  if (state === "mira") {
    return (
      <span className="inline-flex items-center gap-1 rounded-[4px] bg-ai px-1.5 py-px text-[10px] font-medium text-ai-foreground">
        <Icon name="sparkles" size="xs" />
        Mira
      </span>
    );
  }
  if (state === "needs-you") {
    return (
      <span className="rounded-[4px] bg-warning-soft px-1.5 py-px text-[10px] font-medium text-warning">
        Needs you
      </span>
    );
  }
  return (
    <span className="rounded-[4px] bg-good-soft px-1.5 py-px text-[10px] font-medium text-good">Handled</span>
  );
}

/** The Relay inbox: icon rail, conversation list and the open conversation. */
export function InboxWindow() {
  const open = rows[0];
  return (
    <AppWindow>
      <IconRail active={1} />

      {/* Conversation list */}
      <div className="flex w-[268px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <span className="text-[13px] font-semibold">Conversations</span>
          <span className="text-[11px] text-muted-foreground">Marina</span>
        </div>
        <div className="flex gap-1 px-3 pb-2.5 text-[11px]">
          <span className="rounded-[4px] bg-foreground px-2 py-0.5 font-medium text-background">All 24</span>
          <span className="rounded-[4px] px-2 py-0.5 text-muted-foreground">Needs you 2</span>
          <span className="rounded-[4px] px-2 py-0.5 text-muted-foreground">Mira 19</span>
        </div>
        <div className="flex flex-col">
          {rows.map((row) => (
            <div
              key={row.name}
              className={cn(
                "flex gap-2.5 border-l-2 px-3 py-2.5",
                row.selected ? "border-primary bg-accent/60" : "border-transparent",
              )}
            >
              <div className="relative">
                <Avatar row={row} />
                <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-3.5 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
                  <Icon name={channelIcon[row.channel]} size="xs" className="size-2.5" />
                </span>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn("truncate text-[12px]", row.unread ? "font-semibold" : "font-medium")}>
                    {row.name}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{row.time}</span>
                </div>
                <span className="truncate text-[11px] text-muted-foreground">{row.preview}</span>
                <div className="flex items-center gap-1.5">
                  <StateTag state={row.state} />
                  {row.unread ? (
                    <span className="ml-auto inline-flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                      {row.unread}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Open conversation */}
      <div className="flex min-w-[420px] flex-1 flex-col">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
          <Avatar row={open} size="lg" />
          <div className="flex flex-col">
            <span className="text-[13px] font-semibold">{open.name}</span>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Icon name="instagram" size="xs" className="size-2.5" />
              Instagram, Marina branch
            </span>
          </div>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-[6px] border border-border px-2 py-1 text-[11px]">
            <span className="size-1.5 rounded-full bg-good" />
            Assigned to you
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-3 bg-muted/40 px-5 py-4">
          <span className="self-center rounded-full bg-background px-2.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border">
            Today
          </span>
          <p className="max-w-[78%] self-start rounded-[10px] rounded-bl-[3px] bg-background px-3 py-2 text-[12px] leading-[18px] ring-1 ring-border">
            Hi, I think I was charged twice for my last visit. Can someone check?
          </p>
          <div className="flex max-w-[80%] flex-col items-end gap-1 self-end">
            <p className="rounded-[10px] rounded-br-[3px] bg-ai px-3 py-2 text-[12px] leading-[18px] text-ai-foreground">
              Sorry about that, Omar. I've passed this to our billing team and someone will reply here
              shortly.
            </p>
            <span className="flex items-center gap-1 text-[10px] text-ai-foreground/80">
              <Icon name="sparkles" size="xs" className="size-2.5" />
              Mira, AI agent
            </span>
          </div>
          <div className="flex items-center gap-2 self-center rounded-[6px] bg-warning-soft px-2.5 py-1.5 text-[11px] text-warning">
            <Icon name="handoff" size="xs" />
            Mira handed this to you: billing question
          </div>
          <p className="max-w-[60%] self-start rounded-[10px] rounded-bl-[3px] bg-background px-3 py-2 text-[12px] leading-[18px] ring-1 ring-border">
            It was the cleaning on 4 November.
          </p>
        </div>

        <div className="border-t border-border bg-background px-4 py-3">
          <div className="flex items-center gap-2 rounded-[8px] border border-border px-3 py-2">
            <span className="flex-1 text-[12px] text-muted-foreground">Reply to Omar…</span>
            <span className="inline-flex items-center gap-1 rounded-[5px] bg-ai px-1.5 py-0.5 text-[10px] font-medium text-ai-foreground">
              <Icon name="sparkles" size="xs" className="size-2.5" />
              Draft with Mira
            </span>
            <span className="inline-flex size-6 items-center justify-center rounded-[6px] bg-primary text-primary-foreground">
              <Icon name="send" size="xs" />
            </span>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}
