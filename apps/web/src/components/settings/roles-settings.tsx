"use client";

import type { Permission } from "@relay/core/permissions";
import { CheckboxRow } from "@relay/ui/components/choice";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { ModalActions } from "@relay/ui/components/modal";
import { Panel, Section } from "@relay/ui/components/section";
import { SidePanel } from "@relay/ui/components/side-panel";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { errorText } from "./words";

type Role = {
  id: string;
  name: string;
  description: string;
  builtIn: string | null;
  permissions: Permission[];
  people: number;
};
type Group = {
  id: string;
  label: string;
  permissions: { key: Permission; label: string; company?: boolean }[];
};
type Roles = { roles: Role[]; groups: Group[]; canManage: boolean };
type Draft = {
  id?: string;
  name: string;
  description: string;
  permissions: Set<Permission>;
  readOnly: boolean;
};

const col = createDataTableColumns<Role>();

/** Settings → Roles: the built-in roles and the company's own, made by ticking permissions. */
export function RolesSettings() {
  const { can, refresh } = useMe();
  const [data, setData] = useState<Roles | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, confirmElement] = useConfirm();

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setData(await api<Roles>("/roles"));
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const total = data?.groups.reduce((n, g) => n + g.permissions.length, 0) ?? 0;

  const open = useCallback(
    (r: Role | null, copy = false) =>
      setDraft(
        r
          ? {
              id: copy ? undefined : r.id,
              name: copy ? `${r.name} (copy)` : r.name,
              description: r.description,
              permissions: new Set(r.permissions),
              readOnly: !copy && (!!r.builtIn || !data?.canManage),
            }
          : { name: "", description: "", permissions: new Set(), readOnly: false },
      ),
    [data?.canManage],
  );

  const remove = useCallback(
    async (r: Role) => {
      const ok = await confirm({
        title: `Delete ${r.name}?`,
        description: "Nobody has it now. This can't be undone.",
        confirmLabel: "Delete role",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await api(`/roles/${r.id}`, { method: "DELETE" });
        notify.success(`${r.name} deleted`);
        await load();
      } catch (err) {
        notify.error(errorText(err, "Couldn't delete the role."));
      }
    },
    [confirm, load],
  );

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor("name", {
          header: "Role",
          cell: ({ row }) => {
            const r = row.original;
            return (
              <span className="flex max-w-80 min-w-40 flex-col gap-0.5 whitespace-normal">
                <span className="flex items-center gap-2 font-medium">
                  {r.name}
                  {r.builtIn ? <Tag size="sm">Built-in</Tag> : null}
                </span>
                {r.description ? (
                  <span className="line-clamp-2 text-[13px] text-muted-foreground">{r.description}</span>
                ) : null}
              </span>
            );
          },
        }),
        col.accessor("permissions", {
          header: "Allows",
          enableSorting: false,
          cell: ({ row }) => (
            <span className="text-[13px] text-muted-foreground">
              {row.original.permissions.length === total
                ? "Everything"
                : `${row.original.permissions.length} of ${total}`}
            </span>
          ),
        }),
        col.accessor("people", {
          header: "People",
          cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>,
        }),
        col.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const r = row.original;
            return (
              <div className="flex justify-end gap-1">
                <Button size="xs" variant="outline" onClick={() => open(r)}>
                  {r.builtIn || !data?.canManage ? "View" : "Edit"}
                </Button>
                {data?.canManage ? (
                  <IconButton icon="copy" size="sm" label={`Copy ${r.name}`} onClick={() => open(r, true)} />
                ) : null}
                {data?.canManage && !r.builtIn ? (
                  <IconButton
                    icon="delete"
                    size="sm"
                    label={`Delete ${r.name}`}
                    disabled={r.people > 0}
                    onClick={() => void remove(r)}
                  />
                ) : null}
              </div>
            );
          },
        }),
      ]),
    [data?.canManage, open, remove, total],
  );

  if (!can("team.view"))
    return (
      <Panel padding="none">
        <EmptyState
          icon={<Icon name="lock" />}
          title="You can't see roles"
          description="Ask an admin if you need to see or change what roles allow."
        />
      </Panel>
    );

  return (
    <div className="flex flex-col gap-10">
      <Section
        title="Roles"
        description="A role is a set of things people can do. Give roles to people in Team, for the branches and numbers you pick."
        actions={
          data?.canManage ? (
            <Button onClick={() => open(null)}>
              <Icon name="add" />
              New role
            </Button>
          ) : null
        }
      >
        {failed ? (
          <Panel padding="none">
            <EmptyState
              icon={<Icon name="alert" />}
              title="Couldn't load roles"
              action={
                <Button variant="outline" onClick={() => void load()}>
                  Try again
                </Button>
              }
            />
          </Panel>
        ) : (
          <DataTable
            aria-label="Roles"
            columns={columns}
            data={data?.roles ?? []}
            loading={data === null}
            getRowId={(r) => r.id}
          />
        )}
      </Section>
      {data ? (
        <RoleEditor
          draft={draft}
          groups={data.groups}
          onClose={() => setDraft(null)}
          onSaved={async (name) => {
            notify.success(`${name} saved`);
            setDraft(null);
            await Promise.all([load(), refresh()]);
          }}
        />
      ) : null}
      {confirmElement}
    </div>
  );
}

function RoleEditor({
  draft,
  groups,
  onClose,
  onSaved,
}: {
  draft: Draft | null;
  groups: Group[];
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const { can } = useMe();
  const [d, setD] = useState<Draft | null>(draft);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setD(draft);
    setSearch("");
  }, [draft]);
  const q = search.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      permissions: g.permissions.filter(
        (p) => !q || p.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.permissions.length);
  const toggle = (keys: Permission[], on: boolean) =>
    setD((x) => {
      if (!x) return x;
      const next = new Set(x.permissions);
      for (const k of keys) on ? next.add(k) : next.delete(k);
      return { ...x, permissions: next };
    });
  const problem = !d?.name.trim()
    ? "Name the role."
    : !d.permissions.size
      ? "Tick at least one thing."
      : null;
  const readOnly = !!d?.readOnly;
  return (
    <SidePanel
      open={!!d}
      onOpenChange={(o) => !o && onClose()}
      width="md"
      title={readOnly ? (d?.name ?? "Role") : d?.id ? `Change ${draft?.name}` : "New role"}
      description={
        readOnly
          ? "Built-in roles can't be changed. Copy one to make your own."
          : "Changes apply right away to everyone with this role."
      }
      footer={
        readOnly ? (
          <ModalActions>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </ModalActions>
        ) : (
          <ModalActions
            start={problem ? <span className="text-[13px] text-muted-foreground">{problem}</span> : null}
          >
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={saving || !!problem}
              onClick={async () => {
                if (!d) return;
                setSaving(true);
                try {
                  const json = {
                    name: d.name.trim(),
                    description: d.description.trim(),
                    permissions: [...d.permissions],
                  };
                  await api(d.id ? `/roles/${d.id}` : "/roles", { method: d.id ? "PATCH" : "POST", json });
                  await onSaved(json.name);
                } catch (err) {
                  notify.error(errorText(err, "Couldn't save the role."));
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? <Icon name="loading" size="sm" /> : null}
              Save role
            </Button>
          </ModalActions>
        )
      }
    >
      {d ? (
        <div className="flex flex-col gap-5">
          {!readOnly ? (
            <>
              <Field label="Name" required>
                <TextInput
                  value={d.name}
                  onChange={(e) => setD({ ...d, name: e.target.value })}
                  maxLength={60}
                />
              </Field>
              <Field label="What it's for" hint="A line to help people pick the right role.">
                <TextInput
                  value={d.description}
                  onChange={(e) => setD({ ...d, description: e.target.value })}
                  maxLength={300}
                />
              </Field>
            </>
          ) : d.description ? (
            <p className="text-sm text-muted-foreground">{d.description}</p>
          ) : null}
          <TextInput
            type="search"
            aria-label="Find a permission"
            placeholder="Find a permission"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {shown.map((g) => {
            const keys = g.permissions.map((p) => p.key);
            const ticked = keys.filter((k) => d.permissions.has(k)).length;
            return (
              <Panel key={g.id} padding="md" className="flex flex-col">
                <CheckboxRow
                  label={g.label}
                  description={`${ticked} of ${keys.length}`}
                  checked={ticked === 0 ? false : ticked === keys.length ? true : "indeterminate"}
                  disabled={readOnly}
                  onCheckedChange={(on) =>
                    toggle(
                      keys.filter((k) => !on || can(k)),
                      on,
                    )
                  }
                />
                <div className="ml-7 flex flex-col">
                  {g.permissions.map((p) => (
                    <CheckboxRow
                      key={p.key}
                      label={
                        <span className="flex flex-wrap items-center gap-2 font-normal">
                          {p.label}
                          {p.company ? <Tag size="sm">Whole company</Tag> : null}
                        </span>
                      }
                      checked={d.permissions.has(p.key)}
                      // Nobody can make a role that does more than they can.
                      disabled={readOnly || (!d.permissions.has(p.key) && !can(p.key))}
                      onCheckedChange={(on) => toggle([p.key], on)}
                    />
                  ))}
                </div>
              </Panel>
            );
          })}
          {!readOnly ? (
            <p className="text-[13px] text-muted-foreground">
              "Whole company" items only work when the role is given for all branches and all numbers.
            </p>
          ) : null}
        </div>
      ) : null}
    </SidePanel>
  );
}
