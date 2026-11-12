import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils";

const panelPadding = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
} as const;

export type PanelProps = ComponentProps<"div"> & {
  /** none, sm 12px, md 16px (default), lg 24px. Use none for lists and tables that run edge to edge. */
  padding?: keyof typeof panelPadding;
};

/**
 * The bordered surface cards are made of. Use it for any boxed content
 * so pages never hand-write `border rounded bg-card` themselves.
 */
export function Panel({ padding = "md", className, ...props }: PanelProps) {
  return (
    <div
      data-slot="panel"
      className={cn("rounded-lg border bg-card text-card-foreground", panelPadding[padding], className)}
      {...props}
    />
  );
}

export type SectionProps = {
  title: string;
  description?: ReactNode;
  /** Buttons on the right of the heading, for example "Add" or "See all". */
  actions?: ReactNode;
  /** Heading level. Default h2, since the page title is the h1. */
  as?: "h2" | "h3";
  className?: string;
  children: ReactNode;
};

/**
 * A titled block inside a page: a heading, an optional line of explanation and actions,
 * then the content. Use it to split a page or a settings screen into named parts.
 */
export function Section({
  title,
  description,
  actions,
  as: Heading = "h2",
  className,
  children,
}: SectionProps) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Heading className="text-[15px] leading-snug font-semibold">{title}</Heading>
          {description ? <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
