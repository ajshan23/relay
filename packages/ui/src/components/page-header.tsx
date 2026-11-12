import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/utils";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/breadcrumb";

export type Crumb = { label: string; href?: string };

export type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  /** Buttons on the right, for example the page's main action. */
  actions?: ReactNode;
  /**
   * The trail above the title. Pass items (the last one is the current page) or your own node,
   * for example when links need the router's Link component.
   */
  breadcrumb?: Crumb[] | ReactNode;
  /**
   * Use when the surrounding shell already names the page: the big title is hidden
   * (kept for screen readers) and only the description line and actions show.
   */
  compact?: boolean;
  className?: string;
};

function Trail({ items }: { items: Crumb[] }) {
  return (
    <Breadcrumb>
      <BreadcrumbList className="text-[13px]">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <Fragment key={`${c.label}-${c.href ?? i}`}>
              <BreadcrumbItem>
                {last || !c.href ? (
                  <BreadcrumbPage className={last ? undefined : "text-muted-foreground"}>
                    {c.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={c.href}>{c.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {last ? null : <BreadcrumbSeparator />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * The top of every page: title, one line saying what the page is for, and the page's actions.
 * Pages never hand-write their own header.
 */
export function PageHeader({ title, description, actions, breadcrumb, compact, className }: PageHeaderProps) {
  const trail = Array.isArray(breadcrumb) ? <Trail items={breadcrumb as Crumb[]} /> : breadcrumb;

  if (compact) {
    return (
      <header className={cn("flex flex-wrap items-center gap-3 px-5 pt-4 pb-3 sm:px-8", className)}>
        <h1 className="sr-only">{title}</h1>
        {description ? (
          <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">{description}</p>
        ) : (
          <div className="flex-1" />
        )}
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
    );
  }

  return (
    <header className={cn("flex flex-col gap-2 px-5 pt-7 pb-5 sm:px-8", className)}>
      {trail}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
