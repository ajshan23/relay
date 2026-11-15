import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b px-6 py-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({
  title,
  children,
  className,
  right,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border bg-card", className)}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Json({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed",
        className,
      )}
    >
      {value === null || value === undefined ? "null" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}
