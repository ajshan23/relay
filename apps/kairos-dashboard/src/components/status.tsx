import { cn } from "@/lib/utils";

const tone: Record<string, { dot: string; text: string; bg: string }> = {
  completed: { dot: "bg-good", text: "text-good", bg: "bg-good-soft" },
  matched: { dot: "bg-good", text: "text-good", bg: "bg-good-soft" },
  failed: { dot: "bg-destructive", text: "text-destructive", bg: "bg-danger-soft" },
  cancelled: { dot: "bg-muted-foreground", text: "text-muted-foreground", bg: "bg-muted" },
  running: { dot: "bg-primary kairos-breathe", text: "text-accent-foreground", bg: "bg-accent" },
  queued: { dot: "bg-warning", text: "text-warning", bg: "bg-warning-soft" },
  retrying: { dot: "bg-warning", text: "text-warning", bg: "bg-warning-soft" },
  timed_out: { dot: "bg-warning", text: "text-warning", bg: "bg-warning-soft" },
  sleeping: { dot: "bg-rail-past", text: "text-foreground", bg: "bg-secondary" },
  waiting: { dot: "bg-primary", text: "text-foreground", bg: "bg-secondary" },
  open: { dot: "bg-primary", text: "text-foreground", bg: "bg-secondary" },
};

const words: Record<string, string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  running: "Running",
  queued: "Queued",
  retrying: "Retrying",
  timed_out: "Timed out",
  sleeping: "Sleeping",
  waiting: "Waiting",
  open: "Open",
  matched: "Matched",
};

export function Status({ value, className }: { value: string; className?: string }) {
  const t = tone[value] ?? { dot: "bg-muted-foreground", text: "text-muted-foreground", bg: "bg-muted" };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium whitespace-nowrap",
        t.bg,
        t.text,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", t.dot)} aria-hidden />
      {words[value] ?? value}
    </span>
  );
}
