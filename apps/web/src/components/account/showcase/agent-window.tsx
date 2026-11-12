import { Icon, type IconName } from "@relay/ui/components/icon";
import { cn } from "@relay/ui/lib/utils";
import { AppWindow, IconRail } from "./parts";

/* Slide 2: Mira's page. What she has learned on the left, a test chat on the right. */

type Source = { icon: IconName; name: string; detail: string; state: "synced" | "learning" };

const sources: Source[] = [
  { icon: "website", name: "lumendental.ae", detail: "24 pages", state: "synced" },
  { icon: "file", name: "Price list 2026.pdf", detail: "3 pages", state: "synced" },
  { icon: "knowledge", name: "Common questions", detail: "18 answers", state: "learning" },
];

const rules = [
  "Book, move and cancel appointments",
  "Answer prices and opening hours",
  "Hand billing and complaints to a person",
];

export function AgentWindow() {
  return (
    <AppWindow>
      <IconRail active={3} />

      {/* What Mira knows */}
      <div className="flex w-[300px] shrink-0 flex-col gap-4 border-r border-border px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-9 items-center justify-center rounded-full bg-ai text-ai-foreground">
            <Icon name="sparkles" size="sm" />
          </span>
          <div className="flex flex-col">
            <span className="text-[13px] font-semibold">Mira</span>
            <span className="flex items-center gap-1 text-[10px] text-good">
              <span className="size-1.5 rounded-full bg-good" />
              Live on WhatsApp and Instagram
            </span>
          </div>
        </div>

        <div className="flex gap-1 text-[11px]">
          <span className="rounded-[4px] bg-foreground px-2 py-0.5 font-medium text-background">Teach</span>
          <span className="rounded-[4px] px-2 py-0.5 text-muted-foreground">Try</span>
          <span className="rounded-[4px] px-2 py-0.5 text-muted-foreground">Go live</span>
          <span className="rounded-[4px] px-2 py-0.5 text-muted-foreground">Improve</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">What Mira knows</span>
          {sources.map((source) => (
            <div
              key={source.name}
              className="flex items-center gap-2.5 rounded-[8px] border border-border px-2.5 py-2"
            >
              <span className="inline-flex size-7 items-center justify-center rounded-[6px] bg-muted text-muted-foreground">
                <Icon name={source.icon} size="sm" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-medium">{source.name}</span>
                <span className="text-[10px] text-muted-foreground">{source.detail}</span>
              </div>
              <span
                className={cn(
                  "rounded-[4px] px-1.5 py-px text-[10px] font-medium",
                  source.state === "synced" ? "bg-good-soft text-good" : "bg-ai text-ai-foreground",
                )}
              >
                {source.state === "synced" ? "Learned" : "Learning"}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">What Mira may do</span>
          {rules.map((rule, i) => (
            <span key={rule} className="flex items-center gap-2 text-[11px]">
              <Icon
                name={i === rules.length - 1 ? "handoff" : "check"}
                size="xs"
                className={i === rules.length - 1 ? "text-warning" : "text-good"}
              />
              {rule}
            </span>
          ))}
        </div>
      </div>

      {/* Try Mira */}
      <div className="flex min-w-[400px] flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold">Try Mira</span>
          <span className="rounded-[4px] bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            Only you can see this
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-3 bg-muted/40 px-5 py-4">
          <p className="max-w-[75%] self-start rounded-[10px] rounded-bl-[3px] bg-background px-3 py-2 text-[12px] leading-[18px] ring-1 ring-border">
            How much is teeth whitening, and can I come Saturday?
          </p>
          <div className="flex max-w-[82%] flex-col items-end gap-1 self-end">
            <p className="rounded-[10px] rounded-br-[3px] bg-ai px-3 py-2 text-[12px] leading-[18px] text-ai-foreground">
              Whitening is AED 1,200 for a full session. On Saturday we have 10:00 or 14:30 at Marina. Shall I
              book one for you?
            </p>
            <span className="flex items-center gap-1 text-[10px] text-ai-foreground/80">
              <Icon name="file" size="xs" className="size-2.5" />
              From Price list 2026.pdf and Opening hours
            </span>
          </div>
          <p className="max-w-[60%] self-start rounded-[10px] rounded-bl-[3px] bg-background px-3 py-2 text-[12px] leading-[18px] ring-1 ring-border">
            14:30 works
          </p>
          <div className="flex max-w-[82%] flex-col items-end gap-1 self-end">
            <p className="rounded-[10px] rounded-br-[3px] bg-ai px-3 py-2 text-[12px] leading-[18px] text-ai-foreground">
              Done. You're booked for whitening on Saturday at 14:30.
            </p>
          </div>
        </div>
        <div className="border-t border-border bg-background px-4 py-3">
          <div className="flex items-center gap-2 rounded-[8px] border border-border px-3 py-2">
            <span className="flex-1 text-[12px] text-muted-foreground">
              Ask Mira something a customer would…
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
