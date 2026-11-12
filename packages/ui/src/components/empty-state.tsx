import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export type EmptyStateProps = {
  /** A small icon shown in a soft circle above the title. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Usually one button that fixes the emptiness, e.g. "Add customer". */
  action?: ReactNode;
  size?: "sm" | "md";
  className?: string;
};

/**
 * Use when a list, table or panel has nothing to show yet, or a search found nothing.
 * Calm and centred: an optional icon, one line of title, one of explanation, and at most one action.
 */
export function EmptyState({ icon, title, description, action, size = "md", className }: EmptyStateProps) {
  const sm = size === "sm";
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        sm ? "gap-1.5 px-4 py-8" : "gap-2 px-6 py-14",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden
          className={cn(
            "mb-1 inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground",
            sm ? "size-9 [&_svg]:size-4" : "size-11 [&_svg]:size-5",
          )}
        >
          {icon}
        </span>
      ) : null}
      <p className={cn("font-semibold text-foreground", sm ? "text-sm" : "text-base")}>{title}</p>
      {description ? (
        <p className={cn("max-w-sm text-muted-foreground", sm ? "text-[13px]" : "text-sm")}>{description}</p>
      ) : null}
      {action ? <div className={sm ? "mt-2" : "mt-3"}>{action}</div> : null}
    </div>
  );
}
