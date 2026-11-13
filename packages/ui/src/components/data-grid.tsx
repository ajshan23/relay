"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown, GripVertical, Settings2 } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from "react";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Skeleton } from "../ui/skeleton";
import { EmptyState } from "./empty-state";
import { TablePagination } from "./table-pagination";

/*
 * DataGrid: a table whose columns are decided at runtime and whose data is sorted and paged by the
 * server. The page owns every piece of state (columns, widths, sort, selection, page); the grid draws
 * it. Built on the same table styling as DataTable. Use DataTable for small lists held in the browser.
 */

export type GridColumn<T> = {
  id: string;
  header: ReactNode;
  /** Width in px; the user can drag to change it when `onResize` is given. */
  width?: number;
  minWidth?: number;
  /** Stays in place while the grid scrolls sideways (left-most columns only). */
  pinned?: boolean;
  sortable?: boolean;
  align?: "start" | "end";
  cell: (row: T) => ReactNode;
};

export type GridSort = { field: string; dir: "asc" | "desc" } | null;

export type DataGridProps<T> = {
  columns: GridColumn<T>[];
  rows: T[];
  rowId: (row: T) => string;
  sort?: GridSort;
  onSortChange?: (sort: GridSort) => void;
  /** Ids of selected rows; gives the grid a checkbox column. */
  selected?: Set<string>;
  onSelectedChange?: (ids: Set<string>) => void;
  onResize?: (columnId: string, width: number) => void;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  /** Server paging. */
  page?: number;
  pageSize?: number;
  total?: number;
  /** `total` is a floor ("10,000+"): there may be more, and `hasMore` says if there's a next page. */
  totalCapped?: boolean;
  hasMore?: boolean;
  onPageChange?: (page: number) => void;
  /** Extra header cell at the end, e.g. an "Add column" button. */
  trailingHeader?: ReactNode;
  "aria-label"?: string;
  className?: string;
};

const CHECK_WIDTH = 44;

export function DataGrid<T>({
  columns,
  rows,
  rowId,
  sort,
  onSortChange,
  selected,
  onSelectedChange,
  onResize,
  onRowClick,
  loading = false,
  empty,
  page = 1,
  pageSize = 50,
  total,
  totalCapped = false,
  hasMore = false,
  onPageChange,
  trailingHeader,
  "aria-label": ariaLabel,
  className,
}: DataGridProps<T>) {
  const selectable = !!selected && !!onSelectedChange;
  const widthOf = (c: GridColumn<T>) => c.width ?? 180;
  // Left offsets for pinned columns (after the checkbox column).
  const pinnedLeft = new Map<string, number>();
  let left = selectable ? CHECK_WIDTH : 0;
  for (const c of columns) {
    if (!c.pinned) break;
    pinnedLeft.set(c.id, left);
    left += widthOf(c);
  }
  const lastPinned = [...pinnedLeft.keys()].at(-1);
  const allIds = rows.map(rowId);
  const allSelected = selectable && rows.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selectable && !allSelected && allIds.some((id) => selected.has(id));
  const tableWidth =
    (selectable ? CHECK_WIDTH : 0) + columns.reduce((s, c) => s + widthOf(c), 0) + (trailingHeader ? 56 : 0);

  const toggle = (id: string, on: boolean) => {
    if (!selected || !onSelectedChange) return;
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedChange(next);
  };

  const sortBy = (c: GridColumn<T>) => {
    if (!c.sortable || !onSortChange) return;
    if (sort?.field !== c.id) onSortChange({ field: c.id, dir: "asc" });
    else if (sort.dir === "asc") onSortChange({ field: c.id, dir: "desc" });
    else onSortChange(null);
  };

  const stick = (id: string) =>
    pinnedLeft.has(id)
      ? {
          position: "sticky" as const,
          left: pinnedLeft.get(id),
          zIndex: 2,
        }
      : undefined;

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  const pageCount = total
    ? Math.max(1, Math.ceil(total / pageSize), totalCapped ? page + (hasMore ? 1 : 0) : 0)
    : 1;
  const from = (page - 1) * pageSize + 1;
  const summary = totalCapped
    ? `${from.toLocaleString()}–${(from + rows.length - 1).toLocaleString()} of ${total?.toLocaleString()}+`
    : undefined;

  return (
    <div data-slot="data-grid" className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto rounded-xl border bg-card shadow-soft">
        <table
          aria-label={ariaLabel}
          aria-busy={loading || undefined}
          className="table-fixed border-separate border-spacing-0 text-sm"
          style={{ width: tableWidth, minWidth: "100%" }}
        >
          <colgroup>
            {selectable ? <col style={{ width: CHECK_WIDTH }} /> : null}
            {columns.map((c) => (
              <col key={c.id} style={{ width: widthOf(c) }} />
            ))}
            {trailingHeader ? <col style={{ width: 56 }} /> : null}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              {selectable ? (
                <th
                  scope="col"
                  className="sticky left-0 z-20 h-10 border-b bg-card pl-4 text-left"
                  style={{ width: CHECK_WIDTH }}
                >
                  <Checkbox
                    aria-label="Select all rows on this page"
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(v) => {
                      if (!onSelectedChange || !selected) return;
                      const next = new Set(selected);
                      for (const id of allIds) v === true ? next.add(id) : next.delete(id);
                      onSelectedChange(next);
                    }}
                    disabled={loading || rows.length === 0}
                  />
                </th>
              ) : null}
              {columns.map((c) => {
                const sorted = sort?.field === c.id ? sort.dir : null;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                    style={stick(c.id) ? { ...stick(c.id), zIndex: 20 } : undefined}
                    className={cn(
                      "group/th relative h-10 border-b bg-card px-3 text-left align-middle text-[13px] font-medium whitespace-nowrap text-muted-foreground",
                      c.id === lastPinned && "shadow-[inset_-1px_0_0_var(--border)]",
                      c.align === "end" && "text-right",
                    )}
                  >
                    {c.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => sortBy(c)}
                        className={cn(
                          "-mx-1.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                          sorted && "text-foreground",
                        )}
                      >
                        <span className="truncate">{c.header}</span>
                        {sorted === "asc" ? (
                          <ArrowUp className="size-3.5 shrink-0" aria-hidden />
                        ) : sorted === "desc" ? (
                          <ArrowDown className="size-3.5 shrink-0" aria-hidden />
                        ) : (
                          <ChevronsUpDown
                            className="size-3.5 shrink-0 opacity-0 group-hover/th:opacity-50"
                            aria-hidden
                          />
                        )}
                      </button>
                    ) : (
                      <span className="truncate">{c.header}</span>
                    )}
                    {onResize ? <ResizeHandle column={c} width={widthOf(c)} onResize={onResize} /> : null}
                  </th>
                );
              })}
              {trailingHeader ? (
                <th scope="col" className="h-10 border-b bg-card px-2 text-left">
                  {trailingHeader}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity.
                <tr key={i}>
                  {selectable ? <td className="h-11 border-b pl-4" /> : null}
                  {columns.map((c) => (
                    <td key={c.id} className="h-11 border-b px-3">
                      <Skeleton className="h-4 w-3/5" />
                    </td>
                  ))}
                  {trailingHeader ? <td className="border-b" /> : null}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0) + (trailingHeader ? 1 : 0)}
                  className="p-0"
                >
                  <div className="sticky left-0 w-full max-w-[calc(100vw-4rem)]">
                    {empty ?? <EmptyState size="sm" title="Nothing here yet" />}
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const id = rowId(row);
                const isSelected = selectable && selected.has(id);
                return (
                  <tr
                    key={id}
                    data-state={isSelected ? "selected" : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => onRowKey(e, row) : undefined}
                    className={cn(
                      "group/row [&>td]:bg-card hover:[&>td]:bg-muted data-[state=selected]:[&>td]:bg-accent",
                      onRowClick && "cursor-pointer outline-none focus-visible:[&>td]:bg-muted",
                    )}
                  >
                    {selectable ? (
                      <td
                        className="sticky left-0 z-[2] h-11 border-b pl-4"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          aria-label="Select row"
                          checked={isSelected}
                          onCheckedChange={(v) => toggle(id, v === true)}
                        />
                      </td>
                    ) : null}
                    {columns.map((c) => (
                      <td
                        key={c.id}
                        style={stick(c.id)}
                        className={cn(
                          "h-11 overflow-hidden border-b px-3 align-middle whitespace-nowrap text-ellipsis",
                          c.id === lastPinned && "shadow-[inset_-1px_0_0_var(--border)]",
                          c.align === "end" && "text-right",
                        )}
                      >
                        {c.cell(row)}
                      </td>
                    ))}
                    {trailingHeader ? <td className="border-b" /> : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {onPageChange && total !== undefined && total > pageSize ? (
        <TablePagination
          page={page}
          pageCount={pageCount}
          onPageChange={onPageChange}
          totalCount={total}
          pageSize={pageSize}
          summary={summary}
        />
      ) : null}
    </div>
  );
}

/** Drag the right edge of a header to resize its column. */
function ResizeHandle<T>({
  column,
  width,
  onResize,
}: {
  column: GridColumn<T>;
  width: number;
  onResize: (id: string, width: number) => void;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const min = column.minWidth ?? 80;
  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    start.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!start.current) return;
    onResize(column.id, Math.max(min, Math.round(start.current.w + e.clientX - start.current.x)));
  };
  const onUp = () => {
    start.current = null;
  };
  return (
    <button
      type="button"
      aria-label={`Resize column`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onResize(column.id, Math.max(min, width - 16));
        if (e.key === "ArrowRight") onResize(column.id, width + 16);
      }}
      className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize touch-none outline-none after:absolute after:top-2 after:bottom-2 after:left-1/2 after:w-px after:bg-border after:opacity-0 group-hover/th:after:opacity-100 focus-visible:after:bg-ring focus-visible:after:opacity-100"
    />
  );
}

export type ColumnChoice = { id: string; label: string; hidden?: boolean; locked?: boolean };

/**
 * The "Columns" menu: show or hide columns and drag them into a new order. Locked columns (like Name)
 * stay first and visible.
 */
export function ColumnsMenu({
  columns,
  onChange,
}: {
  columns: ColumnChoice[];
  onChange: (columns: ColumnChoice[]) => void;
}) {
  const dragging = useRef<string | null>(null);
  const move = (from: string, to: string) => {
    if (from === to) return;
    const list = [...columns];
    const a = list.findIndex((c) => c.id === from);
    const b = list.findIndex((c) => c.id === to);
    if (a < 0 || b < 0 || list[b]?.locked) return;
    const [item] = list.splice(a, 1);
    if (item) list.splice(b, 0, item);
    onChange(list);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-60 overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Show, hide and drag to reorder
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((c) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: mouse drag to reorder; the checkbox item inside is the keyboard control
          <div
            key={c.id}
            draggable={!c.locked}
            onDragStart={() => {
              dragging.current = c.id;
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragging.current) move(dragging.current, c.id);
            }}
            onDragEnd={() => {
              dragging.current = null;
            }}
            className="flex items-center"
          >
            <GripVertical
              aria-hidden
              className={cn(
                "ml-1 size-3.5 shrink-0 text-muted-foreground",
                c.locked ? "opacity-0" : "cursor-grab",
              )}
            />
            <DropdownMenuCheckboxItem
              className="flex-1"
              checked={!c.hidden}
              disabled={c.locked}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) =>
                onChange(columns.map((x) => (x.id === c.id ? { ...x, hidden: !v } : x)))
              }
            >
              {c.label}
            </DropdownMenuCheckboxItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
