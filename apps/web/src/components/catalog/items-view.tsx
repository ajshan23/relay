"use client";

import { FilterPills } from "@relay/ui/components/choice";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { SearchInput, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { type ReactNode, useMemo, useState } from "react";
import { StorageMeter } from "@/components/settings/storage-settings";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";
import { ItemEditor } from "./item-editor";
import {
  type CatalogCategory,
  type CatalogItem,
  type CatalogOverview,
  categoryLabels,
  commonCurrencies,
  type ItemFilters,
  type ItemRow,
  useCatalog,
  useCatalogActions,
  useCatalogItems,
} from "./queries";
import { TypePicker } from "./types-view";

/*
 * Catalogue → Items: everything this branch sells, with search and filters, bulk actions, and the
 * editor in a side panel. First use asks for the currency and what kind of things the branch sells.
 */

const col = createDataTableColumns<ItemRow>();
const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Try again.";

export function mediaUrl(branchId: string, mediaId: string, preview = false) {
  return `/api/catalog/media/${mediaId}/file?branch=${branchId}${preview ? "&preview=1" : ""}`;
}

export function Thumb({ media, size = 40 }: { media: ItemRow["primaryMedia"]; size?: number }) {
  const branch = useBranch().branch.id;
  const box = { width: size, height: size };
  if (!media || media.status !== "ready")
    return (
      <span
        style={box}
        className="flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <Icon name={media?.status === "processing" ? "loading" : "image"} size="sm" />
      </span>
    );
  return (
    // biome-ignore lint/performance/noImgElement: served by our API with auth cookies
    <img
      src={mediaUrl(branch, media.id, true)}
      alt=""
      style={box}
      loading="lazy"
      className="shrink-0 rounded-md bg-muted object-cover"
    />
  );
}

export function ItemsView({ gallery }: { gallery?: (item: CatalogItem) => ReactNode }) {
  const overview = useCatalog();
  if (overview.isPending)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (overview.isError || !overview.data)
    return (
      <EmptyState
        icon={<Icon name="alert" />}
        title="Couldn't load the catalogue"
        description={errorText(overview.error)}
        action={<Button onClick={() => overview.refetch()}>Try again</Button>}
      />
    );
  const data = overview.data;
  if (!data.currency || !data.types.length) return <FirstSteps overview={data} />;
  return <Items overview={data} gallery={gallery} />;
}

/** Before the first item: the currency, then what the branch sells. */
function FirstSteps({ overview }: { overview: CatalogOverview }) {
  const actions = useCatalogActions();
  const [currency, setCurrency] = useState<string>(overview.currency ?? "AED");
  if (!overview.canManage)
    return (
      <EmptyState
        icon={<Icon name="tag" />}
        title="No catalogue yet"
        description="A manager of this branch can add what you sell."
      />
    );
  if (!overview.currency)
    return (
      <Panel padding="lg" className="flex max-w-xl flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">Which currency are your prices in?</h2>
          <p className="text-sm text-muted-foreground">
            Used for every price in your catalogue. Each price can still be in another currency.
          </p>
        </div>
        <SelectField
          value={currency}
          onValueChange={setCurrency}
          options={commonCurrencies.map((c) => ({ value: c, label: c }))}
          className="w-40"
        />
        <Button
          className="self-start"
          disabled={actions.setCurrency.isPending}
          onClick={() =>
            actions.setCurrency.mutate(currency, {
              onError: (err) => notify.error("Not saved", { description: errorText(err) }),
            })
          }
        >
          Continue
        </Button>
      </Panel>
    );
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">What do you sell?</h2>
        <p className="text-sm text-muted-foreground">
          Pick the closest. It sets the details you fill in for each item, and you can change or add more
          later.
        </p>
      </div>
      <TypePicker overview={overview} />
    </div>
  );
}

function Items({
  overview,
  gallery,
}: {
  overview: CatalogOverview;
  gallery?: (item: CatalogItem) => ReactNode;
}) {
  const actions = useCatalogActions();
  const [confirm, confirmElement] = useConfirm();
  const [filters, setFilters] = useState<ItemFilters>({ q: "", status: "", typeId: "", categoryId: "" });
  const list = useCatalogItems(filters);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const [selected, setSelected] = useState<ItemRow[]>([]);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const categories = useMemo(() => categoryLabels(overview.categories), [overview.categories]);

  const columns = useMemo(() => {
    const typeName = (id: string) => overview.types.find((t) => t.id === id)?.name ?? "";
    const categoryName = (id: string | null) => categories.find((c) => c.value === id)?.label ?? "";
    return [
      col.accessor("title", {
        header: "Item",
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-3">
            <Thumb media={row.original.primaryMedia} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{row.original.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {[typeName(row.original.typeId), categoryName(row.original.categoryId)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </span>
        ),
      }),
      col.accessor("priceText", {
        header: "Price",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="tabular-nums">{row.original.priceText ?? "On request"}</span>
            {row.original.variantCount > 1 ? (
              <span className="text-xs text-muted-foreground">{row.original.variantCount} options</span>
            ) : null}
          </span>
        ),
      }),
      col.accessor("stock", {
        header: "Stock",
        enableSorting: false,
        cell: ({ row }) =>
          !row.original.available ? (
            <Tag size="sm" tone="warning">
              Not available
            </Tag>
          ) : row.original.stock === null ? (
            <span className="text-muted-foreground">Not tracked</span>
          ) : (
            <span className="tabular-nums">{row.original.stock}</span>
          ),
      }),
      col.accessor("status", {
        header: "Status",
        enableSorting: false,
        cell: (info) => (
          <Tag
            size="sm"
            tone={info.getValue() === "active" ? "good" : info.getValue() === "draft" ? "plain" : "warning"}
          >
            {info.getValue() === "active" ? "On sale" : info.getValue() === "draft" ? "Draft" : "Archived"}
          </Tag>
        ),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) =>
          overview.canManage ? (
            <div className="flex justify-end">
              <IconButton
                icon="delete"
                size="sm"
                label={`Delete ${row.original.title}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await confirm({
                    title: `Delete ${row.original.title}?`,
                    description: "Its prices, photos and videos go too. Archive it instead to keep them.",
                    confirmLabel: "Delete",
                    tone: "danger",
                  });
                  if (ok)
                    actions.deleteItem.mutate(row.original.id, {
                      onSuccess: () => notify.success("Deleted"),
                      onError: (err) => notify.error("Not deleted", { description: errorText(err) }),
                    });
                }}
              />
            </div>
          ) : null,
      }),
    ];
  }, [overview, categories, confirm, actions.deleteItem]);

  async function bulk(action: "archive" | "activate" | "delete") {
    const ids = selected.map((r) => r.id);
    if (action === "delete") {
      const ok = await confirm({
        title: `Delete ${ids.length} item${ids.length > 1 ? "s" : ""}?`,
        description: "Their prices, photos and videos go too. This can't be undone.",
        confirmLabel: "Delete",
        tone: "danger",
      });
      if (!ok) return;
    }
    actions.bulk.mutate(
      { ids, action },
      {
        onSuccess: (r) => {
          notify.success(
            `${r.changed} item${r.changed === 1 ? "" : "s"} ${action === "delete" ? "deleted" : action === "archive" ? "archived" : "put on sale"}`,
          );
          setSelected([]);
        },
        onError: (err) => notify.error("Nothing changed", { description: errorText(err) }),
      },
    );
  }

  const addButton = overview.canManage ? (
    <Button size="sm" onClick={() => setEditing({ id: null })}>
      <Icon name="add" />
      Add item
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {confirmElement}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          onSearch={(q) => setFilters((f) => ({ ...f, q: q.trim() }))}
          placeholder="Search name, SKU or details"
          aria-label="Search items"
          className="w-full sm:w-72"
        />
        <SelectField
          value={filters.typeId}
          onValueChange={(typeId) => setFilters((f) => ({ ...f, typeId }))}
          options={[
            { value: "", label: "All types" },
            ...overview.types.map((t) => ({ value: t.id, label: t.name })),
          ]}
          size="sm"
          className="w-40"
          aria-label="Type"
        />
        <SelectField
          value={filters.categoryId}
          onValueChange={(categoryId) => setFilters((f) => ({ ...f, categoryId }))}
          options={[{ value: "", label: "All categories" }, ...categories]}
          size="sm"
          className="w-48"
          aria-label="Category"
        />
        <div className="ml-auto flex items-center gap-3">
          <StorageMeter compact />
          {overview.canManage ? (
            <Button size="sm" variant="outline" onClick={() => setCategoriesOpen(true)}>
              Categories
            </Button>
          ) : null}
          {addButton}
        </div>
      </div>
      <FilterPills
        aria-label="Status"
        value={filters.status}
        onChange={(status) => setFilters((f) => ({ ...f, status }))}
        options={[
          { value: "", label: "On sale and drafts" },
          { value: "active", label: "On sale", count: overview.counts.active ?? 0 },
          { value: "draft", label: "Drafts", count: overview.counts.draft ?? 0 },
          { value: "archived", label: "Archived", count: overview.counts.archived ?? 0 },
        ]}
      />
      {selected.length && overview.canManage ? (
        <Panel padding="sm" className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{selected.length} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setCopyOpen(true)}>
              Copy to branch
            </Button>
            <Button size="sm" variant="outline" onClick={() => bulk("activate")}>
              Put on sale
            </Button>
            <Button size="sm" variant="outline" onClick={() => bulk("archive")}>
              Archive
            </Button>
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => bulk("delete")}>
              Delete
            </Button>
          </div>
        </Panel>
      ) : null}
      <DataTable
        aria-label="Catalogue items"
        columns={columns}
        data={rows}
        loading={list.isPending}
        getRowId={(r) => r.id}
        selection={overview.canManage ? "multi" : "none"}
        onSelectionChange={setSelected}
        onRowClick={(r) => setEditing({ id: r.id })}
        pageSize={500}
        empty={
          <EmptyState
            icon={<Icon name="tag" />}
            title={filters.q || filters.typeId || filters.categoryId ? "Nothing matches" : "Nothing here yet"}
            description={
              filters.q || filters.typeId || filters.categoryId
                ? "Try other words or clear the filters."
                : "Add what you sell, with prices and photos. Mira shows them to customers on WhatsApp."
            }
            action={filters.q || filters.typeId || filters.categoryId ? undefined : addButton}
          />
        }
      />
      {list.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          Show more
        </Button>
      ) : null}
      <ItemEditor
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        itemId={editing?.id ?? null}
        overview={overview}
        gallery={gallery}
      />
      <CategoriesModal
        open={categoriesOpen}
        onOpenChange={setCategoriesOpen}
        categories={overview.categories}
      />
    </div>
  );
}

function CategoriesModal({
  open,
  onOpenChange,
  categories,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: CatalogCategory[];
}) {
  const actions = useCatalogActions();
  const [confirm, confirmElement] = useConfirm();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const labels = categoryLabels(categories);
  const add = () =>
    actions.saveCategory.mutate(
      { name: name.trim(), parentId: parentId || null },
      {
        onSuccess: () => setName(""),
        onError: (err) => notify.error("Not added", { description: errorText(err) }),
      },
    );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Categories"
      description="Group what you sell. Categories can sit inside others."
    >
      {confirmElement}
      <div className="flex flex-col gap-4">
        {labels.length ? (
          <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
            {labels.map((c) => (
              <li key={c.value} className="flex items-center gap-2 px-3 py-2 text-sm">
                {renaming?.id === c.value ? (
                  <TextInput
                    value={renaming.name}
                    autoFocus
                    onChange={(e) => setRenaming({ id: c.value, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && renaming.name.trim())
                        actions.saveCategory.mutate(
                          {
                            id: c.value,
                            name: renaming.name.trim(),
                            parentId: categories.find((x) => x.id === c.value)?.parentId ?? null,
                          },
                          { onSuccess: () => setRenaming(null) },
                        );
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="flex-1 truncate">{c.label}</span>
                )}
                <IconButton
                  icon="edit"
                  size="sm"
                  label={`Rename ${c.label}`}
                  onClick={() =>
                    setRenaming({ id: c.value, name: categories.find((x) => x.id === c.value)?.name ?? "" })
                  }
                />
                <IconButton
                  icon="delete"
                  size="sm"
                  label={`Delete ${c.label}`}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Delete ${c.label}?`,
                      description: "Items in it stay, without a category.",
                      confirmLabel: "Delete",
                      tone: "danger",
                    });
                    if (ok) actions.deleteCategory.mutate(c.value);
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No categories yet.</p>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <Field label="New category">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
            />
          </Field>
          <Field label="Inside">
            <SelectField
              value={parentId}
              onValueChange={setParentId}
              options={[{ value: "", label: "Top level" }, ...labels]}
            />
          </Field>
          <Button disabled={!name.trim() || actions.saveCategory.isPending} onClick={add}>
            Add
          </Button>
        </div>
      </div>
      <ModalActions>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </ModalActions>
    </Modal>
  );
}

function CopyModal({
  open,
  onOpenChange,
  ids,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ids: string[];
  onDone: () => void;
}) {
  const { branch, branches } = useBranch();
  const { me, canManageOrg } = useMe();
  const actions = useCatalogActions();
  // Branches this person manages (owners and admins manage all).
  const managed = new Set(me.branches.filter((b) => canManageOrg || b.role === "manager").map((b) => b.id));
  const targets = branches.filter((b) => b.id !== branch.id && managed.has(b.id));
  const [to, setTo] = useState("");
  const target = to || targets[0]?.id || "";
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Copy ${ids.length} item${ids.length === 1 ? "" : "s"} to another branch`}
      description="Prices, options, categories, photos and videos are copied. Photos aren't stored twice."
    >
      {targets.length ? (
        <Field label="Copy to">
          <SelectField
            value={target}
            onValueChange={setTo}
            options={targets.map((b) => ({ value: b.id, label: b.name }))}
          />
        </Field>
      ) : (
        <p className="text-sm text-muted-foreground">You don't manage another branch to copy to.</p>
      )}
      <ModalActions>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          disabled={!target || actions.copy.isPending}
          onClick={() =>
            actions.copy.mutate(
              { ids, toBranchId: target },
              {
                onSuccess: (r) => {
                  notify.success(
                    `${r.copied} item${r.copied === 1 ? "" : "s"} copied to ${branches.find((b) => b.id === target)?.name}`,
                    r.skusCleared
                      ? {
                          description: `${r.skusCleared} SKU${r.skusCleared === 1 ? " was" : "s were"} already used there, so left empty.`,
                        }
                      : undefined,
                  );
                  onDone();
                  onOpenChange(false);
                },
                onError: (err) => notify.error("Not copied", { description: errorText(err) }),
              },
            )
          }
        >
          Copy
        </Button>
      </ModalActions>
    </Modal>
  );
}
