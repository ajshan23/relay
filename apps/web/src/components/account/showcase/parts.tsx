import { Icon, type IconName } from "@relay/ui/components/icon";
import { cn } from "@relay/ui/lib/utils";
import type { ReactNode } from "react";

/* Shared pieces of the product pictures beside the sign-in card. */

/** A person's initials on a soft colour. */
export function Avatar({
  row,
  size = "md",
}: {
  row: { initials: string; tint: string };
  size?: "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        size === "lg" ? "size-8 text-[11px]" : "size-7 text-[10px]",
        row.tint,
      )}
    >
      {row.initials}
    </span>
  );
}

/** The inside of the app window. The frame, border and shadow belong to the carousel, which keeps them still. */
export function AppWindow({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full overflow-hidden rounded-tl-[14px] bg-background text-foreground">
      {children}
    </div>
  );
}

/** The narrow icon sidebar, with one section marked active. */
export function IconRail({ active }: { active: number }) {
  const items: IconName[] = ["sparkles", "conversations", "customers", "agent", "campaigns", "insights"];
  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-nav py-3">
      <span className="mb-2 inline-flex size-7 items-center justify-center rounded-[6px] bg-primary text-[11px] font-bold text-primary-foreground">
        L
      </span>
      {items.map((icon, i) => (
        <span
          key={icon}
          className={cn(
            "inline-flex size-8 items-center justify-center rounded-[6px]",
            i === active ? "bg-nav-active text-nav-foreground" : "text-nav-muted",
          )}
        >
          <Icon name={icon} size="sm" />
        </span>
      ))}
    </div>
  );
}

/** A notification card that floats over the window: the one moment each slide is about. */
export function FloatingCard({
  icon,
  tone = "ai",
  title,
  body,
}: {
  icon: IconName;
  tone?: "ai" | "good";
  title: string;
  body: string;
}) {
  return (
    <div className="flex w-[280px] items-start gap-3 rounded-[12px] border border-border bg-background p-3.5 text-foreground shadow-[0_20px_50px_-12px_rgb(10_4_30/0.45)]">
      <span
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-[8px]",
          tone === "ai" ? "bg-ai text-ai-foreground" : "bg-good-soft text-good",
        )}
      >
        <Icon name={icon} size="sm" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12px] font-semibold">{title}</span>
        <span className="text-[11px] leading-4 text-muted-foreground">{body}</span>
      </div>
    </div>
  );
}
