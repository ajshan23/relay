import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import { Icon, type IconName } from "./icon";

/**
 * What a tag or dot means. `ai` is only for things the AI agent did or owns;
 * `primary` is a calm violet highlight for anything else worth noticing.
 */
export type Tone = "plain" | "ai" | "good" | "danger" | "warning" | "primary";

const tagVariant = {
  plain: "secondary",
  ai: "ai",
  good: "good",
  danger: "danger",
  warning: "warning",
  primary: "accent",
} as const satisfies Record<Tone, string>;

export type TagProps = {
  tone?: Tone;
  /** sm 20px high, md 24px high (default). */
  size?: "sm" | "md";
  /** Optional leading icon, for example a channel. */
  icon?: IconName;
  className?: string;
  children: ReactNode;
};

/**
 * A small pill that labels a row: stage, owner, status, channel.
 * Use it for read-only labels; for a filter people click, use a button.
 */
export function Tag({ tone = "plain", size = "md", icon, className, children }: TagProps) {
  return (
    <Badge variant={tagVariant[tone]} size={size} data-tone={tone} className={className}>
      {icon ? <Icon name={icon} size="xs" /> : null}
      {children}
    </Badge>
  );
}

const dotTone: Record<Tone, string> = {
  plain: "bg-muted-foreground",
  ai: "bg-ai-strong",
  good: "bg-good",
  danger: "bg-destructive",
  warning: "bg-warning",
  primary: "bg-primary",
};

export type StatusDotProps = {
  tone?: Tone;
  /** sm 6px, md 8px (default). */
  size?: "sm" | "md";
  /** Adds a soft pulsing ring for something happening right now. Still when the user prefers reduced motion. */
  live?: boolean;
  /** Read out by screen readers. Leave empty when text next to the dot already says it. */
  label?: string;
  className?: string;
};

/**
 * A coloured dot for status at a glance: online, sending, failed.
 * Pair it with text; colour alone never carries the meaning.
 */
export function StatusDot({ tone = "plain", size = "md", live = false, label, className }: StatusDotProps) {
  const colour = dotTone[tone];
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <span
      {...a11y}
      data-tone={tone}
      className={cn("relative inline-flex shrink-0", size === "sm" ? "size-1.5" : "size-2", className)}
    >
      {live ? (
        <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", colour)} />
      ) : null}
      <span className={cn("relative inline-block size-full rounded-full", colour)} />
    </span>
  );
}
