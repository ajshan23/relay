import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 px-6 pt-8 pb-6 lg:px-10">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A page's content column. */
export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-6 px-6 pb-12 lg:px-10", className)}>{children}</div>;
}

export function Section({
  title,
  description,
  children,
  className,
  right,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card shadow-elevated", className)}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div>
          <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "good" | "bad" | "warn" | "live";
}) {
  return (
    <div className="rounded-xl border bg-card px-5 py-4 shadow-elevated">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        {tone ? (
          <span
            className={cn(
              "size-1.5 rounded-full",
              tone === "good" && "bg-good",
              tone === "bad" && "bg-destructive",
              tone === "warn" && "bg-warning",
              tone === "live" && "kairos-breathe bg-primary",
            )}
            aria-hidden
          />
        ) : null}
        {label}
      </div>
      <div className="mt-2 text-[30px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
        {value}
      </div>
      {hint ? <div className="mt-2 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Json({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-lg border bg-muted/60 px-3 py-2.5 font-mono text-[12px] leading-relaxed",
        className,
      )}
    >
      {value === null || value === undefined ? "null" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-12 text-center text-sm text-muted-foreground">{children}</div>;
}
