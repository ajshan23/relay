"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { cn } from "../lib/utils";

type StatVariant = "tiles" | "strip";

const StatVariantContext = createContext<StatVariant | null>(null);

export type StatProps = {
  value: ReactNode;
  label: ReactNode;
  /** A short line under the label, e.g. "4 more than yesterday". */
  note?: ReactNode;
  /** Direction of change. Shown as a small arrow before the note; "up" reads as good, "down" as bad. */
  trend?: "up" | "down" | "flat";
  className?: string;
};

const trendIcon = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;
const trendTone = { up: "text-good", down: "text-destructive", flat: "text-muted-foreground" } as const;
const trendLabel = { up: "Up", down: "Down", flat: "No change" } as const;

/**
 * Use for one headline number with its label, such as "38 chats handled today".
 * Place several inside a `StatGroup`; on its own it renders as a tile.
 */
export function Stat({ value, label, note, trend, className }: StatProps) {
  const groupVariant = useContext(StatVariantContext);
  const strip = groupVariant === "strip";
  // Outside a StatGroup the stat brings its own <dl> so the dt/dd pair stays valid.
  const Root = groupVariant ? "div" : "dl";
  const TrendIcon = trend ? trendIcon[trend] : null;
  return (
    <Root
      data-slot="stat"
      className={cn(
        "flex min-w-0 flex-col",
        strip ? "p-4" : "rounded-xl border border-border bg-card p-4 shadow-soft",
        className,
      )}
    >
      <dt className={cn("order-2", strip ? "text-sm text-muted-foreground" : "font-medium")}>{label}</dt>
      <dd
        className={cn(
          "order-1 font-display font-semibold tracking-tight tabular-nums",
          strip ? "text-2xl" : "text-3xl",
        )}
      >
        {value}
      </dd>
      {note || TrendIcon ? (
        <dd className="order-3 mt-1 flex items-center gap-1 text-sm text-muted-foreground">
          {TrendIcon && trend ? (
            <span className={cn("inline-flex items-center", trendTone[trend])}>
              <TrendIcon aria-hidden className="size-4" />
              <span className="sr-only">{trendLabel[trend]}</span>
            </span>
          ) : null}
          {note}
        </dd>
      ) : null}
    </Root>
  );
}

export type StatGroupProps = {
  children: ReactNode;
  /** "tiles" lays stats out as separate cards in a responsive grid; "strip" joins them in one divided card. */
  variant?: StatVariant;
  className?: string;
};

/**
 * Use to show a row of `Stat`s at the top of a page or home screen.
 * Tiles wrap from one to four columns; the strip is two columns on small screens and four on large ones.
 */
export function StatGroup({ children, variant = "tiles", className }: StatGroupProps) {
  return (
    <StatVariantContext.Provider value={variant}>
      <dl
        data-slot="stat-group"
        className={cn(
          variant === "strip"
            ? "grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-soft lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none lg:divide-y-0"
            : "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4",
          className,
        )}
      >
        {children}
      </dl>
    </StatVariantContext.Provider>
  );
}
