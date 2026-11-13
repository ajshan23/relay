"use client";

import { coreColumns, defaultView, type ViewConfig } from "@relay/core/contacts";
import { Segmented } from "@relay/ui/components/choice";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { type ColumnChoice, ColumnsMenu, DataGrid, type GridColumn } from "@relay/ui/components/data-grid";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { PageHeader } from "@relay/ui/components/page-header";
import { Person } from "@relay/ui/components/person";
import { SearchInput, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Checkbox } from "@relay/ui/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@relay/ui/ui/popover";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { channelIcon } from "@/components/inbox/conversation-list";
import { listTime } from "@/components/inbox/format";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError } from "@/lib/api";
import { AddFieldPopover } from "./add-field";
import { EditableCell, FieldEditor, FieldValue, TagChips } from "./cells";
import { ContactProfile } from "./contact-profile";
import { FilterBar } from "./filter-bar";
import { ImportDialog } from "./import-dialog";
import { MarketingEditor, MarketingStatus } from "./marketing";
import {
  type ContactList,
  type ContactRow,
  type ContactsMeta,
  download,
  inBranch,
  type SavedView,
  useContactActions,
  useContacts,
  useContactsMeta,
} from "./queries";
import { TagPicker } from "./tag-picker";

const PAGE_SIZE = 50;

/** The built-in views in the sidebar; saved views use their own id. */
export const builtInViews: Record<string, { label: string; config: ViewConfig }> = {
  all: { label: "All contacts", config: defaultView },
  new: {
    label: "New this week",
    config: {
      ...defaultView,
      filter: { match: "all", rules: [{ field: "createdAt", op: "in_last_days", value: 7 }] },
      sort: { field: "createdAt", dir: "desc" },
    },
  },
  "opted-out": {
    label: "Opted out",
    config: { ...defaultView, filter: { match: "all", rules: [{ field: "marketing", op: "is_false" }] } },
  },
};

const coreWidths: Record<string, number> = {
  name: 240,
  phone: 170,
  email: 220,
  tags: 220,
  lastMessageAt: 140,
  createdAt: 130,
  marketing: 190,
};

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Every column the table can show, in the view's order: its columns first, then anything new. */
function columnOrder(config: ViewConfig, meta: ContactsMeta) {
  const known = new Set([...Object.keys(coreColumns), ...meta.fields.map((f) => `attr.${f.key}`)]);
  const list = config.columns.filter((c) => known.has(c.id));
  const seen = new Set(list.map((c) => c.id));
  for (const id of Object.keys(coreColumns)) if (!seen.has(id)) list.push({ id, hidden: true });
  for (const f of meta.fields) if (!seen.has(`attr.${f.key}`)) list.push({ id: `attr.${f.key}` });
  // Name always first.
  const name = list.find((c) => c.id === "name") ?? { id: "name" };
  return [{ ...name, hidden: false }, ...list.filter((c) => c.id !== "name")];
}

export function ContactsPage() {
  const params = useSearchParams();
  const viewId = params.get("view") ?? "all";
  const listId = params.get("list");
  const meta = useContactsMeta();

  if (!meta.data)
    return (
      <div className="flex flex-col gap-3 px-5 py-8 sm:px-8">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );

  const list = listId ? meta.data.lists.find((l) => l.id === listId) : undefined;
  if (list)
    return (
      <ContactsTable
        key={list.id}
        meta={meta.data}
        base={list.kind === "smart" && list.filter ? { ...defaultView, filter: list.filter } : defaultView}
        saved={undefined}
        list={list}
        title={list.name}
      />
    );
  const saved = meta.data.views.find((v) => v.id === viewId);
  const builtIn = builtInViews[viewId] ?? builtInViews.all;
  const base = saved?.config ?? builtIn?.config ?? defaultView;
  // A new view resets the working copy.
  return (
    <ContactsTable
      key={viewId}
      meta={meta.data}
      base={base}
      saved={saved}
      title={saved?.name ?? builtIn?.label ?? "Contacts"}
    />
  );
}

function ContactsTable({
  meta,
  base,
  saved,
  list: inList,
  title,
}: {
  meta: ContactsMeta;
  base: ViewConfig;
  saved: SavedView | undefined;
  /** Showing one list: static lists by membership, smart lists through their filter. */
  list?: ContactList;
  title: string;
}) {
  const actions = useContactActions();
  const branchId = useBranch().branch.id;
  const [confirm, confirmElement] = useConfirm();
  const [config, setConfig] = useState<ViewConfig>(base);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [newList, setNewList] = useState(false);

  const staticListId = inList?.kind === "static" ? inList.id : undefined;
  const list = useContacts({
    filter: config.filter,
    sort: config.sort,
    q,
    page,
    pageSize: PAGE_SIZE,
    listId: staticListId,
  });
  const rows = list.data?.contacts ?? [];
  const total = list.data?.total ?? 0;
  const dirty = JSON.stringify(config) !== JSON.stringify(base);
  const order = columnOrder(config, meta);
  const fieldsByKey = new Map(meta.fields.map((f) => [f.key, f]));

  const update = (patch: Partial<ViewConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    if (patch.filter || patch.sort !== undefined) setPage(1);
  };

  const save = (id: string, patch: Parameters<typeof actions.update.mutate>[0]["patch"], done?: () => void) =>
    actions.update.mutate(
      { id, patch },
      {
        onSuccess: () => done?.(),
        onError: (err) =>
          notify.error("Couldn't save that", {
            description: err instanceof ApiError ? err.message : undefined,
          }),
      },
    );

  const columns = (() => {
    const out: GridColumn<ContactRow>[] = [];
    for (const col of order) {
      if (col.hidden) continue;
      const width = col.width;
      if (col.id.startsWith("attr.")) {
        const f = fieldsByKey.get(col.id.slice(5));
        if (!f) continue;
        out.push({
          id: col.id,
          header: f.label,
          width: width ?? (f.type === "multi_select" || f.type === "text" ? 200 : 150),
          sortable: f.type !== "multi_select",
          cell: (r) => (
            <EditableCell
              canEdit={meta.canEdit}
              label={f.label}
              display={<FieldValue field={f} value={r.attributes[f.key]} />}
              editor={(close) => (
                <FieldEditor
                  field={f}
                  value={r.attributes[f.key]}
                  onSave={(v) =>
                    save(r.id, { attributes: { [f.key]: v } }, f.type === "multi_select" ? undefined : close)
                  }
                />
              )}
            />
          ),
        });
        continue;
      }
      const id = col.id as keyof typeof coreColumns;
      const header = coreColumns[id].label;
      const w = width ?? coreWidths[id] ?? 160;
      switch (id) {
        case "name":
          out.push({
            id,
            header,
            width: w,
            pinned: true,
            sortable: true,
            cell: (r) => {
              const name = r.name ?? (r.phone ? `+${r.phone}` : "Unnamed");
              return (
                <span className="flex min-w-0 items-center gap-2">
                  <Person name={r.name ?? "?"} size="xs" decorative />
                  <span className={r.name ? "truncate font-medium" : "truncate text-muted-foreground"}>
                    {name}
                  </span>
                </span>
              );
            },
          });
          break;
        case "phone":
          out.push({
            id,
            header,
            width: w,
            sortable: true,
            cell: (r) => (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate tabular-nums">{r.phone ? `+${r.phone}` : "—"}</span>
                {[...new Set(r.channels.map((ch) => ch.type))].map((t) => (
                  <Icon key={t} name={channelIcon(t)} size="xs" className="shrink-0 text-muted-foreground" />
                ))}
              </span>
            ),
          });
          break;
        case "email":
          out.push({
            id,
            header,
            width: w,
            sortable: true,
            cell: (r) => {
              const f = {
                id: "email",
                key: "email",
                label: "Email",
                type: "email" as const,
                options: [],
                position: 0,
              };
              return (
                <EditableCell
                  canEdit={meta.canEdit}
                  label="email"
                  display={<FieldValue field={f} value={r.email} />}
                  editor={(close) => (
                    <FieldEditor
                      field={f}
                      value={r.email}
                      onSave={(v) => save(r.id, { email: (v as string) ?? null }, close)}
                    />
                  )}
                />
              );
            },
          });
          break;
        case "tags":
          out.push({
            id,
            header,
            width: w,
            cell: (r) => (
              <EditableCell
                canEdit={meta.canEdit}
                label="tags"
                display={<TagChips ids={r.tagIds} tags={meta.tags} />}
                editor={() => (
                  <TagPicker
                    tags={meta.tags}
                    value={r.tagIds}
                    onChange={(tagIds) => save(r.id, { tagIds })}
                  />
                )}
              />
            ),
          });
          break;
        case "lastMessageAt":
          out.push({
            id,
            header,
            width: w,
            sortable: true,
            cell: (r) =>
              r.lastMessageAt ? (
                <span className="text-muted-foreground">{listTime(r.lastMessageAt)}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          });
          break;
        case "createdAt":
          out.push({
            id,
            header,
            width: w,
            sortable: true,
            cell: (r) => (
              <span className="text-muted-foreground">{dateFmt.format(new Date(r.createdAt))}</span>
            ),
          });
          break;
        case "marketing":
          out.push({
            id,
            header,
            width: w,
            sortable: true,
            cell: (r) => (
              <EditableCell
                canEdit={meta.canEdit}
                label="marketing"
                display={<MarketingStatus optOuts={r.optOuts} channels={meta.channels} />}
                editor={() => (
                  <MarketingEditor
                    optOuts={r.optOuts}
                    channels={meta.channels}
                    canEdit={meta.canEdit}
                    onChange={(channelAccountId, optedOut) =>
                      save(r.id, { optOut: { channelAccountId, optedOut } })
                    }
                  />
                )}
              />
            ),
          });
          break;
      }
    }
    return out;
  })();

  const choices: ColumnChoice[] = order.map((c) => ({
    id: c.id,
    label: c.id.startsWith("attr.")
      ? (fieldsByKey.get(c.id.slice(5))?.label ?? c.id)
      : coreColumns[c.id as keyof typeof coreColumns].label,
    hidden: c.hidden,
    locked: c.id === "name",
  }));

  const ids = [...selected];
  const bulk = (action: string, extra: Record<string, unknown> = {}, done?: string) =>
    actions.bulk.mutate(
      { ids, action, ...extra },
      {
        onSuccess: ({ affected }) => {
          notify.success(done ?? "Done", {
            description: `${affected} ${affected === 1 ? "contact" : "contacts"}`,
          });
          if (action === "delete") setSelected(new Set());
        },
        onError: (err) =>
          notify.error("Couldn't do that", {
            description: err instanceof ApiError ? err.message : undefined,
          }),
      },
    );

  const exportAs = (format: "xlsx" | "csv") =>
    download(inBranch("/contacts/export", branchId), {
      method: "POST",
      json: {
        filter: config.filter,
        sort: config.sort,
        q,
        listId: staticListId,
        format,
        columns: order.filter((c) => !c.hidden).map((c) => c.id),
      },
    }).catch((e: Error) => notify.error("Couldn't export", { description: e.message }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {confirmElement}
      <PageHeader
        title={title}
        description={
          list.data
            ? `${inList ? (inList.kind === "smart" ? "Smart list · " : "List · ") : ""}${total.toLocaleString()} ${total === 1 ? "contact" : "contacts"}`
            : "Everyone who has talked to you"
        }
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Icon name="download" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  The columns, filters and sort you see
                </DropdownMenuLabel>
                {(["xlsx", "csv"] as const).map((format) => (
                  <DropdownMenuItem key={format} onSelect={() => exportAs(format)}>
                    {format === "xlsx" ? "Excel (.xlsx)" : "CSV"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {meta.canEdit ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
                  <Icon name="upload" />
                  Import
                </Button>
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Icon name="addUser" />
                  Add contact
                </Button>
              </>
            ) : null}
          </>
        }
        className="pb-3"
      />

      <div className="flex flex-wrap items-center gap-2 px-5 pb-3 sm:px-8">
        <div className="w-full sm:w-64">
          <SearchInput
            size="sm"
            placeholder="Search name, phone or email"
            aria-label="Search contacts"
            onSearch={(v) => {
              setQ(v);
              setPage(1);
            }}
          />
        </div>
        <FilterBar meta={meta} filter={config.filter} onChange={(filter) => update({ filter })} />
        <div className="ml-auto flex items-center gap-2">
          {dirty && inList?.kind === "smart" ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfig(base)}>
                Reset
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!config.filter.rules.length}
                onClick={() =>
                  actions.saveList.mutate(
                    { id: inList.id, filter: config.filter },
                    {
                      onSuccess: () => notify.success("List updated"),
                      onError: (err) =>
                        notify.error("Couldn't update the list", {
                          description: err instanceof ApiError ? err.message : undefined,
                        }),
                    },
                  )
                }
              >
                Update list
              </Button>
            </>
          ) : dirty ? (
            <SaveView
              config={config}
              saved={saved}
              canManage={meta.canManage}
              canEdit={meta.canEdit && !inList}
              onReset={() => setConfig(base)}
            />
          ) : null}
          <ColumnsMenu
            columns={choices}
            onChange={(next) =>
              update({
                columns: next.map((c) => ({
                  id: c.id,
                  hidden: c.hidden || undefined,
                  width: order.find((o) => o.id === c.id)?.width,
                })),
              })
            }
          />
        </div>
      </div>

      {selected.size ? (
        <div className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-1.5 sm:mx-8">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <BulkTags
              tags={meta.tags}
              onApply={(tagIds, remove) =>
                bulk(remove ? "remove_tags" : "add_tags", { tagIds }, remove ? "Tags removed" : "Tags added")
              }
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  More
                  <Icon name="chevronDown" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Add to list</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {meta.lists
                      .filter((l) => l.kind === "static")
                      .map((l) => (
                        <DropdownMenuItem
                          key={l.id}
                          onSelect={() => bulk("add_to_list", { listId: l.id }, `Added to ${l.name}`)}
                        >
                          {l.name}
                        </DropdownMenuItem>
                      ))}
                    {meta.lists.some((l) => l.kind === "static") ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem onSelect={() => setNewList(true)}>
                      <Icon name="add" />
                      New list…
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {staticListId ? (
                  <DropdownMenuItem
                    onSelect={() =>
                      bulk("remove_from_list", { listId: staticListId }, `Removed from ${inList?.name}`)
                    }
                  >
                    Remove from this list
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                {(["opt_out", "opt_in"] as const).map((action) => (
                  <DropdownMenuSub key={action}>
                    <DropdownMenuSubTrigger>
                      {action === "opt_out" ? "Opt out of marketing" : "Subscribe to marketing"}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {[{ id: null as string | null, name: "All channels" }, ...meta.channels].map((ch) => (
                        <DropdownMenuItem
                          key={ch.id ?? "all"}
                          onSelect={() =>
                            bulk(
                              action,
                              { channelAccountId: ch.id },
                              action === "opt_out"
                                ? `Opted out on ${ch.id ? ch.name : "all channels"}`
                                : `Subscribed on ${ch.id ? ch.name : "all channels"}`,
                            )
                          }
                        >
                          {ch.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
                {meta.canManage ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={async () => {
                        const ok = await confirm({
                          title: `Delete ${selected.size} ${selected.size === 1 ? "contact" : "contacts"}?`,
                          description:
                            "Their details, tags and notes are removed. Past conversations stay in the inbox.",
                          confirmLabel: "Delete",
                          tone: "danger",
                        });
                        if (ok) bulk("delete", {}, "Deleted");
                      }}
                    >
                      Delete
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ) : null}

      <DataGrid
        aria-label="Contacts"
        className="min-h-0 flex-1 px-5 pb-4 sm:px-8"
        columns={columns}
        rows={rows}
        rowId={(r) => r.id}
        loading={list.isPending}
        sort={config.sort}
        onSortChange={(sort) => update({ sort })}
        selected={selected}
        onSelectedChange={setSelected}
        onResize={(id, width) => update({ columns: order.map((c) => (c.id === id ? { ...c, width } : c)) })}
        onRowClick={(r) => setOpenId(r.id)}
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        empty={
          <div className="flex flex-col items-center gap-1 py-10 text-center">
            <p className="font-medium">
              {config.filter.rules.length || q ? "No contacts match" : "No contacts yet"}
            </p>
            <p className="text-sm text-muted-foreground">
              {config.filter.rules.length || q
                ? "Try another search or remove a filter."
                : "People who write to your channels show up here, or add one yourself."}
            </p>
          </div>
        }
        trailingHeader={
          meta.canManage ? (
            <AddFieldPopover
              trigger={
                <button
                  type="button"
                  aria-label="Add a field"
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Icon name="add" size="sm" />
                </button>
              }
            />
          ) : undefined
        }
      />

      <ContactProfile id={openId} meta={meta} onClose={() => setOpenId(null)} />
      <ImportDialog open={importing} onOpenChange={setImporting} meta={meta} />
      <NewListModal
        open={newList}
        onOpenChange={setNewList}
        onCreate={(name) =>
          actions.saveList.mutate(
            { name, kind: "static" },
            {
              onSuccess: ({ list: created }) => {
                setNewList(false);
                bulk("add_to_list", { listId: created.id }, `Added to ${created.name}`);
              },
              onError: (err) =>
                notify.error("Couldn't create the list", {
                  description: err instanceof ApiError ? err.message : undefined,
                }),
            },
          )
        }
      />
      <NewContact
        open={adding}
        onOpenChange={setAdding}
        onCreated={(id) => {
          setAdding(false);
          setOpenId(id);
        }}
      />
    </div>
  );
}

function SaveView({
  config,
  saved,
  canManage,
  canEdit,
  onReset,
}: {
  config: ViewConfig;
  saved: SavedView | undefined;
  canManage: boolean;
  /** May save the filters as a smart list. */
  canEdit: boolean;
  onReset: () => void;
}) {
  const actions = useContactActions();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const canList = canEdit && config.filter.rules.length > 0;
  const [as, setAs] = useState<"view" | "list">("view");
  const asList = canList && as === "list";
  const canUpdate = saved && (saved.shared ? canManage : true);
  const create = () =>
    asList
      ? actions.saveList.mutate(
          { name: name.trim(), kind: "smart", filter: config.filter },
          {
            onSuccess: ({ list }) => {
              notify.success(`“${list.name}” saved`, {
                description: "A smart list: anyone who matches these filters, always up to date.",
              });
              setOpen(false);
              router.push(`/contacts?list=${list.id}`);
            },
            onError: (err) =>
              notify.error("Couldn't save the list", {
                description: err instanceof ApiError ? err.message : undefined,
              }),
          },
        )
      : actions.saveView.mutate(
          { name: name.trim(), shared, config },
          {
            onSuccess: ({ view }) => {
              notify.success(`“${view.name}” saved`, { description: "It's in the sidebar under Contacts." });
              setOpen(false);
              router.push(`/contacts?view=${view.id}`);
            },
            onError: (err) =>
              notify.error("Couldn't save the view", {
                description: err instanceof ApiError ? err.message : undefined,
              }),
          },
        );
  return (
    <>
      <Button variant="ghost" size="sm" onClick={onReset}>
        Reset
      </Button>
      {canUpdate ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            actions.saveView.mutate(
              { id: saved.id, name: saved.name, config },
              { onSuccess: () => notify.success("View updated") },
            )
          }
        >
          Save
        </Button>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant={canUpdate ? "ghost" : "outline"} size="sm">
            {canUpdate ? "Save as new" : "Save"}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-4">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create();
            }}
          >
            {canList ? (
              <Segmented
                size="sm"
                fullWidth
                aria-label="Save as"
                options={[
                  { value: "view", label: "View" },
                  { value: "list", label: "Smart list" },
                ]}
                value={as}
                onChange={setAs}
              />
            ) : null}
            <p className="-mt-1 text-xs text-muted-foreground">
              {asList
                ? "A list for broadcasts. Contacts join and leave it as they match the filters."
                : "Your columns, filters and sort, one click away in the sidebar."}
            </p>
            <Field label={asList ? "List name" : "View name"}>
              <TextInput
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Gold members"
              />
            </Field>
            {canManage && !asList ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={shared} onCheckedChange={(v) => setShared(v === true)} />
                Share with the whole team
              </label>
            ) : null}
            <Button
              type="submit"
              size="sm"
              disabled={!name.trim() || actions.saveView.isPending || actions.saveList.isPending}
            >
              {asList ? "Save list" : "Save view"}
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </>
  );
}

function BulkTags({
  tags,
  onApply,
}: {
  tags: ContactsMeta["tags"];
  onApply: (ids: string[], remove: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const done = (remove: boolean) => {
    onApply(picked, remove);
    setPicked([]);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Icon name="tag" />
          Tags
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <TagPicker tags={tags} value={picked} onChange={setPicked} />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={!picked.length} onClick={() => done(true)}>
            Remove
          </Button>
          <Button size="sm" disabled={!picked.length} onClick={() => done(false)}>
            Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NewContact({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const actions = useContactActions();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setName("");
    setPhone("");
    setEmail("");
    setError(null);
  };
  const submit = () =>
    actions.create.mutate(
      { name: name.trim() || null, phone: phone.trim() || null, email: email.trim() || null },
      {
        onSuccess: ({ contact }) => {
          notify.success("Contact added");
          reset();
          onCreated(contact.id);
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't add the contact."),
      },
    );
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      title="Add a contact"
      description="Give a phone number so their messages join this contact when they write in."
      size="sm"
      footer={
        <ModalActions>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            form="new-contact"
            type="submit"
            disabled={(!phone.trim() && !email.trim()) || actions.create.isPending}
          >
            Add contact
          </Button>
        </ModalActions>
      }
    >
      <form
        id="new-contact"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" optional>
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Phone" hint="With country code." error={error ?? undefined}>
          <TextInput
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+971 50 123 4567"
          />
        </Field>
        <Field label="Email" optional>
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function NewListModal({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setName("");
      }}
      title="New list"
      description="Add the selected contacts to a new list. You can send broadcasts to it later."
      size="sm"
      footer={
        <ModalActions>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button form="new-list" type="submit" disabled={!name.trim()}>
            Create and add
          </Button>
        </ModalActions>
      }
    >
      <form
        id="new-list"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim());
        }}
      >
        <Field label="List name">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Spring recall"
          />
        </Field>
      </form>
    </Modal>
  );
}
