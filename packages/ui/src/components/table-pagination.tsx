"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";

export type TablePaginationProps = {
  /** Current page, starting at 1. */
  page: number;
  pageCount: number;
  /** Called with the new page, starting at 1. */
  onPageChange: (page: number) => void;
  /** When given with `pageSize`, shows "1–25 of 312" on the left. */
  totalCount?: number;
  pageSize?: number;
  className?: string;
};

type PageSlot = number | "gap-start" | "gap-end";

/** Compact page list: first, last, current and its neighbours, with gaps between. */
function pageSlots(page: number, pageCount: number): PageSlot[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const start = Math.max(2, Math.min(page - 1, pageCount - 4));
  const end = Math.min(pageCount - 1, Math.max(page + 1, 5));
  const slots: PageSlot[] = [1];
  if (start > 2) slots.push("gap-start");
  for (let p = start; p <= end; p++) slots.push(p);
  if (end < pageCount - 1) slots.push("gap-end");
  slots.push(pageCount);
  return slots;
}

/**
 * Use under a list or table that shows one page of results at a time.
 * `DataTable` renders this for you when you pass `pageSize`; use it directly for server-paged lists.
 */
export function TablePagination({
  page,
  pageCount,
  onPageChange,
  totalCount,
  pageSize,
  className,
}: TablePaginationProps) {
  const pages = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), pages);
  const hasSummary = totalCount !== undefined && pageSize !== undefined;
  const from = hasSummary ? (totalCount === 0 ? 0 : (current - 1) * pageSize + 1) : 0;
  const to = hasSummary ? Math.min(current * pageSize, totalCount) : 0;

  return (
    <nav
      aria-label="Pagination"
      data-slot="table-pagination"
      className={cn("flex flex-wrap items-center justify-between gap-3 text-[13px]", className)}
    >
      <p className="text-muted-foreground tabular-nums" aria-live="polite">
        {hasSummary ? `${from}–${to} of ${totalCount}` : `Page ${current} of ${pages}`}
      </p>
      <ul className="flex items-center gap-1">
        <li>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 px-2"
            onClick={() => onPageChange(current - 1)}
            disabled={current <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft aria-hidden />
            <span className="hidden sm:inline">Previous</span>
          </Button>
        </li>
        {pageSlots(current, pages).map((slot) =>
          typeof slot === "number" ? (
            <li key={slot} className={cn(slot !== current && "hidden sm:block")}>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "tabular-nums",
                  slot === current &&
                    "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => onPageChange(slot)}
                aria-current={slot === current ? "page" : undefined}
                aria-label={`Page ${slot}`}
              >
                {slot}
              </Button>
            </li>
          ) : (
            <li key={slot} aria-hidden className="hidden w-6 text-center text-muted-foreground sm:block">
              …
            </li>
          ),
        )}
        <li>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 px-2"
            onClick={() => onPageChange(current + 1)}
            disabled={current >= pages}
            aria-label="Next page"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight aria-hidden />
          </Button>
        </li>
      </ul>
    </nav>
  );
}
