"use client";

import {
  type CellData,
  type Column,
  type ColumnDef,
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  type PaginationState,
  type RowData,
  type RowSelectionState,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  type Updater,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import { cn } from "../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState } from "./empty-state";
import { TablePagination } from "./table-pagination";

/**
 * The TanStack Table features every `DataTable` registers: client-side sorting, row selection and pagination.
 * Column definitions are typed against this, so build them with `createDataTableColumns`.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    datetime: sortFn_datetime,
    basic: sortFn_basic,
  },
  rowSelectionFeature,
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type DataTableFeatures = typeof dataTableFeatures;

/** One column of a `DataTable`. Prefer building columns with `createDataTableColumns`. */
// biome-ignore lint/suspicious/noExplicitAny: TanStack's own column arrays widen each column's value type to `any`.
export type DataTableColumnDef<TData extends RowData, TValue = any> = ColumnDef<
  DataTableFeatures,
  TData,
  TValue
>;

/**
 * Use to define `DataTable` columns tersely with typed accessors.
 *
 * @example
 * const col = createDataTableColumns<Customer>();
 * const columns = col.columns([
 *   col.accessor("name", { header: "Name" }),
 *   col.accessor("stage", { header: "Stage", enableSorting: false }),
 * ]);
 */
export function createDataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

export type DataTableProps<TData extends RowData> = {
  columns: ReadonlyArray<DataTableColumnDef<TData>>;
  data: TData[];
  /** A stable id per row. Defaults to the row index; pass one whenever rows can be selected or reordered. */
  getRowId?: (row: TData, index: number) => string;
  /** Makes rows clickable and keyboard-focusable; Enter on a focused row also calls this. */
  onRowClick?: (row: TData) => void;
  /** "multi" adds a checkbox column. */
  selection?: "none" | "multi";
  /** Called with the selected rows (in data order) whenever the selection changes. */
  onSelectionChange?: (rows: TData[]) => void;
  /** Shows skeleton rows instead of data. */
  loading?: boolean;
  /** Shown when there are no rows. Defaults to a small "Nothing here yet" empty state. */
  empty?: ReactNode;
  /** Row height: "comfortable" is about 48px, "compact" about 40px. */
  density?: "comfortable" | "compact";
  /**
   * Keeps the header visible while rows scroll. The table becomes its own scroll area, so give it a
   * height through `className` (for example `h-[480px]`, or `min-h-0 flex-1` in a full-height page).
   */
  stickyHeader?: boolean;
  /** When set, the table shows this many rows per page and renders pagination under it. */
  pageSize?: number;
  /** Accessible name for the table. */
  "aria-label"?: string;
  className?: string;
};

const noSelection: RowSelectionState = {};

function resolve<T>(updater: Updater<T>, previous: T): T {
  return typeof updater === "function" ? (updater as (old: T) => T)(previous) : updater;
}

/**
 * Use for any list of records shown as rows and columns: customers, chats, campaigns, team members.
 * Handles sorting, selection, loading, empty and paging; pages pass columns and data only.
 */
export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  onRowClick,
  selection = "none",
  onSelectionChange,
  loading = false,
  empty,
  density = "comfortable",
  stickyHeader = false,
  pageSize,
  "aria-label": ariaLabel,
  className,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>(noSelection);
  const [pageIndex, setPageIndex] = useState(0);

  const tableColumns = useMemo(() => [...columns], [columns]);
  const pageCount = pageSize ? Math.max(1, Math.ceil(data.length / pageSize)) : 1;
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pagination = useMemo<PaginationState>(
    () => ({ pageIndex: safePageIndex, pageSize: pageSize ?? Number.MAX_SAFE_INTEGER }),
    [safePageIndex, pageSize],
  );

  const handleSelectionChange = useCallback(
    (updater: Updater<RowSelectionState>) => {
      const next = resolve(updater, rowSelection);
      setRowSelection(next);
      onSelectionChange?.(
        data.filter((row, index) => next[getRowId ? getRowId(row, index) : String(index)] === true),
      );
    },
    [data, getRowId, onSelectionChange, rowSelection],
  );

  const table = useTable({
    features: dataTableFeatures,
    columns: tableColumns,
    data,
    getRowId,
    state: { sorting, rowSelection, pagination },
    onSortingChange: (updater) => setSorting((previous) => resolve(updater, previous)),
    onRowSelectionChange: handleSelectionChange,
    onPaginationChange: (updater) => setPageIndex(resolve(updater, pagination).pageIndex),
    enableRowSelection: selection === "multi",
    enableMultiSort: false,
    autoResetPageIndex: true,
  });

  const selectable = selection === "multi";
  const rows = table.getRowModel().rows;
  const leafColumnCount = table.getAllLeafColumns().length + (selectable ? 1 : 0);
  const rowHeight = density === "compact" ? "h-10" : "h-12";
  const currentPage = safePageIndex + 1;
  const skeletonRows = Math.min(pageSize ?? 5, 8);

  const allSelected = table.getIsAllRowsSelected();
  const someSelected = table.getIsSomeRowsSelected();

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, original: TData) => {
    if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      onRowClick?.(original);
    }
  };

  return (
    <div data-slot="data-table" className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div
        className={cn(
          "rounded-xl border border-border bg-card shadow-soft",
          stickyHeader
            ? "scroll-thin min-h-0 flex-1 overflow-auto [&>[data-slot=table-container]]:overflow-visible"
            : "overflow-hidden",
        )}
      >
        <Table aria-label={ariaLabel} aria-busy={loading || undefined}>
          <TableHeader className={cn(stickyHeader && "sticky top-0 z-10 bg-card")}>
            {table.getHeaderGroups().map((group) => (
              <TableRow
                key={group.id}
                className={cn(
                  "hover:bg-transparent",
                  stickyHeader && "border-b-0 shadow-[inset_0_-1px_0_var(--border)]",
                )}
              >
                {selectable ? (
                  <TableHead scope="col" className="w-10 pl-4">
                    <Checkbox
                      aria-label="Select all rows"
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={(value) => table.toggleAllRowsSelected(value === true)}
                      disabled={loading || data.length === 0}
                    />
                  </TableHead>
                ) : null}
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  // Plain-text headers get the sort button here; custom headers use SortableHeader themselves.
                  const headerDef = header.column.columnDef.header;
                  const wrapSort =
                    header.column.getCanSort() && (headerDef === undefined || typeof headerDef === "string");
                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      colSpan={header.colSpan > 1 ? header.colSpan : undefined}
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                      }
                      className="first:pl-4 last:pr-4"
                    >
                      {header.isPlaceholder ? null : wrapSort ? (
                        <SortableHeader column={header.column}>
                          <table.FlexRender header={header} />
                        </SortableHeader>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: skeletonRows }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity.
                <TableRow key={i} className="hover:bg-transparent">
                  {Array.from({ length: leafColumnCount }, (_, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells have no identity.
                    <TableCell key={c} className={cn(rowHeight, "py-0 first:pl-4 last:pr-4")}>
                      <Skeleton className={cn("h-4", c === 0 && selectable ? "size-4" : "w-3/5")} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={leafColumnCount} className="p-0 whitespace-normal">
                  {empty ?? <EmptyState size="sm" title="Nothing here yet" />}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const isSelected = row.getIsSelected();
                return (
                  <TableRow
                    key={row.id}
                    data-state={isSelected ? "selected" : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    onKeyDown={onRowClick ? (event) => onRowKeyDown(event, row.original) : undefined}
                    className={cn(
                      onRowClick &&
                        "cursor-pointer outline-none focus-visible:bg-muted focus-visible:shadow-[inset_2px_0_0_var(--ring)]",
                    )}
                  >
                    {selectable ? (
                      <TableCell
                        className={cn(rowHeight, "w-10 py-0 pl-4")}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          aria-label="Select row"
                          checked={isSelected}
                          disabled={!row.getCanSelect()}
                          onCheckedChange={(value) => row.toggleSelected(value === true)}
                        />
                      </TableCell>
                    ) : null}
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} className={cn(rowHeight, "py-0 first:pl-4 last:pr-4")}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {pageSize && !loading && data.length > pageSize ? (
        <TablePagination
          page={currentPage}
          pageCount={pageCount}
          onPageChange={(page) => setPageIndex(Math.min(Math.max(page, 1), pageCount) - 1)}
          totalCount={data.length}
          pageSize={pageSize}
        />
      ) : null}
    </div>
  );
}

export type SortableHeaderProps<TData extends RowData, TValue extends CellData = CellData> = {
  column: Column<DataTableFeatures, TData, TValue>;
  children: ReactNode;
  className?: string;
};

/**
 * Use inside a custom column header (a `header` function) to make it sort on click. `DataTable`
 * already wraps plain-text sortable headers in this, so reach for it only when a header renders its own markup.
 *
 * @example
 * col.accessor("amount", { header: ({ column }) => <SortableHeader column={column}>Amount</SortableHeader> })
 */
export function SortableHeader<TData extends RowData, TValue extends CellData = CellData>({
  column,
  children,
  className,
}: SortableHeaderProps<TData, TValue>) {
  const sorted = column.getIsSorted();
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;
  return (
    <button
      type="button"
      onClick={column.getToggleSortingHandler()}
      className={cn(
        "-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-medium outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        sorted && "text-foreground",
        className,
      )}
    >
      {children}
      <Icon aria-hidden className={cn("size-3.5", !sorted && "opacity-50")} />
    </button>
  );
}
