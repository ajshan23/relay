import { Icon } from "@relay/ui/components/icon";
import { AppWindow, IconRail } from "./parts";

/* Slide 3: a WhatsApp campaign, with the message customers see and how it did. */

const stats = [
  { label: "Sent", value: "1,240" },
  { label: "Delivered", value: "98%" },
  { label: "Read", value: "71%" },
  { label: "Replied", value: "186" },
];

const replies = [
  { name: "Layla H.", text: "Yes please, Thursday afternoon?", tag: "Mira booked" },
  { name: "Daniel M.", text: "How much is the check-up now?", tag: "Mira answered" },
  { name: "Rana A.", text: "I moved to Abu Dhabi, any branch there?", tag: "Needs you" },
];

export function CampaignWindow() {
  return (
    <AppWindow>
      <IconRail active={4} />

      {/* The campaign */}
      <div className="flex w-[300px] shrink-0 flex-col gap-4 border-r border-border px-4 py-3.5">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold">Check-up reminder</span>
          <span className="text-[11px] text-muted-foreground">Sent today at 10:00, Marina and Downtown</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="flex flex-col gap-0.5 rounded-[8px] border border-border px-3 py-2"
            >
              <span className="text-[10px] text-muted-foreground">{stat.label}</span>
              <span className="text-[17px] leading-6 font-semibold tracking-[-0.01em]">{stat.value}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Who it went to</span>
          <div className="flex items-center gap-2 rounded-[8px] border border-border px-2.5 py-2 text-[12px]">
            <Icon name="customers" size="sm" className="text-muted-foreground" />
            <span className="flex-1">Not seen in 6 months</span>
            <span className="text-[11px] text-muted-foreground">1,264</span>
          </div>
          <div className="flex items-center gap-2 rounded-[8px] border border-border px-2.5 py-2 text-[12px]">
            <Icon name="whatsapp" size="sm" className="text-muted-foreground" />
            <span className="flex-1">WhatsApp, opted in</span>
            <span className="text-[11px] text-muted-foreground">1,240</span>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-[8px] bg-ai px-2.5 py-2 text-[11px] text-ai-foreground">
          <Icon name="sparkles" size="xs" />
          Mira is answering the replies
        </div>
      </div>

      {/* What customers see, and what came back */}
      <div className="flex min-w-[400px] flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold">Message</span>
          <span className="rounded-[4px] bg-good-soft px-1.5 py-px text-[10px] font-medium text-good">
            Approved by Meta
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-4 bg-muted/40 px-5 py-4">
          <div className="flex w-[300px] flex-col overflow-hidden rounded-[10px] bg-background ring-1 ring-border">
            <div className="flex flex-col gap-1.5 px-3 py-2.5 text-[12px] leading-[18px]">
              <span className="font-semibold">Time for your check-up, {"{{name}}"}</span>
              <span className="text-muted-foreground">
                It has been six months since your last visit to Lumen Dental. Book a slot this week and get a
                free polish.
              </span>
            </div>
            <div className="grid grid-cols-2 border-t border-border text-[12px] font-medium text-primary">
              <span className="flex items-center justify-center gap-1 py-2">
                <Icon name="calendar" size="xs" />
                Book now
              </span>
              <span className="flex items-center justify-center border-l border-border py-2">Not now</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">Latest replies</span>
            {replies.map((reply) => (
              <div
                key={reply.name}
                className="flex items-center gap-2.5 rounded-[8px] bg-background px-3 py-2 ring-1 ring-border"
              >
                <span className="w-[64px] shrink-0 text-[11px] font-medium">{reply.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {reply.text}
                </span>
                <span
                  className={
                    reply.tag === "Needs you"
                      ? "shrink-0 rounded-[4px] bg-warning-soft px-1.5 py-px text-[10px] font-medium text-warning"
                      : "shrink-0 rounded-[4px] bg-ai px-1.5 py-px text-[10px] font-medium text-ai-foreground"
                  }
                >
                  {reply.tag}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppWindow>
  );
}
