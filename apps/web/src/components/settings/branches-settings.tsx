"use client";

import { ConfirmDialog } from "@relay/ui/components/confirm-dialog";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Panel, Section } from "@relay/ui/components/section";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type Branch } from "@/lib/api";
import { useMe } from "@/lib/me";
import { BranchFormModal } from "./branch-form-modal";
import { BranchPeoplePanel } from "./branch-people-panel";
import { errorText, timezoneLabel } from "./words";

const col = createDataTableColumns<Branch>();

/** Settings → Branches: every branch the signed-in person can reach, and what they can do with it. */
export function BranchesSettings() {
  const { me, can, refresh } = useMe();
  const canAdd = can("branches.create");
  const canArchive = can("branches.delete");
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Each overlay keeps its branch after closing, so titles don't change during the close animation.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [peopleOf, setPeopleOf] = useState<Branch | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState<Branch | null>(null);

  const openForm = (branch: Branch | null) => {
    setEditing(branch);
    setFormOpen(true);
  };

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await api<{ branches: Branch[] }>("/branches");
      setBranches(res.branches);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const afterChange = useCallback(async () => {
    await Promise.all([load(), refresh()]);
  }, [load, refresh]);

  const archive = async (branch: Branch) => {
    try {
      await api(`/branches/${branch.id}`, { method: "DELETE" });
      notify.success(`${branch.name} archived`);
      await afterChange();
    } catch (err) {
      notify.error(errorText(err, "Couldn't archive the branch. Try again."));
      // Retrying won't help when it is the last branch, so close the dialog; otherwise keep it open.
      if (err instanceof ApiError && err.code === "last_branch") {
        setArchiveOpen(false);
        return;
      }
      throw err;
    }
  };

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor("name", {
          header: "Branch",
          cell: (info) => (
            <span className="flex items-center gap-2.5">
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <Icon name="branch" size="sm" />
              </span>
              <span className="font-medium">{info.getValue()}</span>
            </span>
          ),
        }),
        col.accessor("timezone", {
          header: "Timezone",
          cell: (info) => <span className="text-muted-foreground">{timezoneLabel(info.getValue())}</span>,
        }),
        col.accessor("memberCount", {
          header: "People",
          cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
        }),
        col.accessor("role", {
          header: "You",
          enableSorting: false,
          cell: (info) => (
            <Tag tone={me.owner ? "primary" : "plain"} size="sm">
              {info.getValue() ?? "No role"}
            </Tag>
          ),
        }),
        col.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const branch = row.original;
            const canEdit = can("branches.edit", branch.id);
            return (
              <div className="flex items-center justify-end gap-0.5">
                <IconButton
                  icon="users"
                  size="sm"
                  label={`People in ${branch.name}`}
                  onClick={() => {
                    setPeopleOf(branch);
                    setPeopleOpen(true);
                  }}
                />
                {canEdit ? (
                  <IconButton
                    icon="edit"
                    size="sm"
                    label={`Rename or change timezone of ${branch.name}`}
                    onClick={() => {
                      setEditing(branch);
                      setFormOpen(true);
                    }}
                  />
                ) : null}
                {canArchive ? (
                  <IconButton
                    icon="archive"
                    size="sm"
                    label={`Archive ${branch.name}`}
                    onClick={() => {
                      setArchiving(branch);
                      setArchiveOpen(true);
                    }}
                  />
                ) : null}
              </div>
            );
          },
        }),
      ]),
    [can, canArchive, me.owner],
  );

  const addButton = canAdd ? (
    <Button onClick={() => openForm(null)}>
      <Icon name="add" />
      Add branch
    </Button>
  ) : null;

  return (
    <Section
      title="Branches"
      description={
        canAdd
          ? "Each branch is one shop or location, with its own chats, team and timezone."
          : "The branches you work in. Ask an owner or admin to add a new one."
      }
      actions={addButton}
    >
      {failed ? (
        <Panel padding="none">
          <EmptyState
            icon={<Icon name="alert" />}
            title="Couldn't load your branches"
            description="Check your connection and try again."
            action={
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        </Panel>
      ) : (
        <DataTable
          aria-label="Branches"
          columns={columns}
          data={branches ?? []}
          loading={branches === null}
          getRowId={(b) => b.id}
          empty={
            <EmptyState
              icon={<Icon name="branch" />}
              title="No branches yet"
              description={
                canAdd
                  ? "Add your first shop or location so chats and your team have somewhere to go."
                  : "You haven't been added to a branch yet. Ask an owner or admin to add you."
              }
              action={addButton}
            />
          }
        />
      )}

      <BranchFormModal open={formOpen} onOpenChange={setFormOpen} branch={editing} onSaved={afterChange} />

      <BranchPeoplePanel branch={peopleOf} open={peopleOpen} onOpenChange={setPeopleOpen} onChanged={load} />

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={archiving ? `Archive ${archiving.name}?` : "Archive branch?"}
        description="The branch disappears from the sidebar and from everyone's lists. Nothing is deleted: its chats, customers and history are kept."
        confirmLabel="Archive branch"
        tone="danger"
        onConfirm={() => (archiving ? archive(archiving) : undefined)}
      />
    </Section>
  );
}
