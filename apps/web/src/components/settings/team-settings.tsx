"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { Person } from "@relay/ui/components/person";
import { Panel, Section } from "@relay/ui/components/section";
import { SidePanel } from "@relay/ui/components/side-panel";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AccessGrant, api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { useBranch } from "../shell/branch-context";
import {
  AccessEditor,
  type BranchOption,
  emptyGrant,
  grantProblem,
  grantSummary,
  type NumberOption,
  type RoleOption,
} from "./access-editor";
import { errorText } from "./words";

type TeamPerson = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  owner: boolean;
  you: boolean;
  grants: AccessGrant[];
};
type TeamInvitation = {
  id: string;
  email: string;
  expiresAt: string;
  expired: boolean;
  grants: AccessGrant[];
};
type Team = {
  people: TeamPerson[];
  invitations: TeamInvitation[];
  roles: RoleOption[];
  branches: BranchOption[];
  numbers: NumberOption[];
  canInvite: boolean;
  canEditAccess: boolean;
  canRemove: boolean;
};

const personCol = createDataTableColumns<TeamPerson>();
const inviteCol = createDataTableColumns<TeamInvitation>();
const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** Settings → Team: everyone in the company, what each can do (roles in branches and numbers), invitations. */
export function TeamSettings() {
  const { me, can, refresh } = useMe();
  const [team, setTeam] = useState<Team | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<TeamPerson | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setTeam(await api<Team>("/team"));
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (p: TeamPerson) => {
      const ok = await confirm({
        title: `Remove ${p.name} from the team?`,
        description:
          "They can't sign in to this business any more and lose every branch right away. Their open chats become unassigned; the history stays.",
        confirmLabel: "Remove from team",
        tone: "danger",
      });
      if (!ok) return;
      setBusy(p.userId);
      try {
        await api(`/team/${p.userId}`, { method: "DELETE" });
        notify.success(`${p.name} removed from the team`);
        await load();
      } catch (err) {
        notify.error(errorText(err, "Couldn't remove them. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [confirm, load],
  );

  const cancelInvitation = useCallback(
    async (inv: TeamInvitation) => {
      setBusy(inv.id);
      try {
        await api(`/team/invitations/${inv.id}`, { method: "DELETE" });
        notify.success(`Invitation for ${inv.email} cancelled`);
        await load();
      } catch (err) {
        notify.error(errorText(err, "Couldn't cancel the invitation. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const personColumns = useMemo(
    () =>
      personCol.columns([
        personCol.accessor("name", {
          header: "Person",
          cell: ({ row }) => {
            const p = row.original;
            return (
              <span className="flex min-w-0 items-center gap-2.5">
                <Person name={p.name} src={p.image ?? undefined} size="sm" decorative />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {p.name}
                    {p.you ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
                  </span>
                  <span className="truncate text-[13px] text-muted-foreground">{p.email}</span>
                </span>
              </span>
            );
          },
        }),
        personCol.display({
          id: "access",
          header: "Can do",
          cell: ({ row }) => {
            const p = row.original;
            if (p.owner)
              return (
                <Tag size="sm" tone="primary">
                  Owner: everything
                </Tag>
              );
            if (!p.grants.length)
              return <span className="text-[13px] text-muted-foreground">No access yet</span>;
            return (
              <span className="flex max-w-72 min-w-40 flex-col gap-0.5 text-[13px] whitespace-normal">
                {p.grants.map((g) => (
                  <span key={g.id}>{team ? grantSummary(g, team) : g.roleName}</span>
                ))}
              </span>
            );
          },
        }),
        personCol.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const p = row.original;
            if (p.owner || p.you) return null;
            return (
              <div className="flex justify-end gap-1">
                {team?.canEditAccess ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy === p.userId}
                    onClick={() => setEditing(p)}
                  >
                    Change access
                  </Button>
                ) : null}
                {team?.canRemove ? (
                  <IconButton
                    icon="delete"
                    size="sm"
                    label={`Remove ${p.name} from the team`}
                    disabled={busy === p.userId}
                    onClick={() => void remove(p)}
                  />
                ) : null}
              </div>
            );
          },
        }),
      ]),
    [busy, remove, team],
  );

  const inviteColumns = useMemo(
    () =>
      inviteCol.columns([
        inviteCol.accessor("email", {
          header: "Email",
          cell: (info) => <span className="font-medium">{info.getValue()}</span>,
        }),
        inviteCol.display({
          id: "access",
          header: "Joins as",
          cell: ({ row }) => (
            <span className="flex flex-col gap-0.5 text-[13px]">
              {row.original.grants.map((g) => (
                <span key={g.id}>{team ? grantSummary(g, team) : g.roleName}</span>
              ))}
            </span>
          ),
        }),
        inviteCol.accessor("expiresAt", {
          header: "Link works until",
          cell: ({ row }) =>
            row.original.expired ? (
              <Tag size="sm" tone="warning">
                Expired
              </Tag>
            ) : (
              <span className="text-muted-foreground">
                {dateFormat.format(new Date(row.original.expiresAt))}
              </span>
            ),
        }),
        inviteCol.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const inv = row.original;
            return (
              <div className="flex items-center justify-end gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `${window.location.origin}/accept-invitation/${inv.id}`,
                      );
                      notify.success("Link copied");
                    } catch {
                      notify.error("Couldn't copy. Your browser blocked it.");
                    }
                  }}
                >
                  <Icon name="copy" size="sm" />
                  Copy link
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy === inv.id}
                  onClick={() => void cancelInvitation(inv)}
                >
                  Cancel
                </Button>
              </div>
            );
          },
        }),
      ]),
    [busy, cancelInvitation, team],
  );

  if (!can("team.view"))
    return (
      <Panel padding="none">
        <EmptyState
          icon={<Icon name="lock" />}
          title="You can't see the team"
          description="Ask an admin if you need to see who's in the team or change what people can do."
        />
      </Panel>
    );

  return (
    <div className="flex flex-col gap-10">
      <Section
        title="People"
        description={
          <>
            What each person can do comes from their roles, in the branches and numbers you pick.{" "}
            <Link
              href="/settings/roles"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Roles
            </Link>{" "}
            lists what each role allows.
          </>
        }
        actions={
          team?.canInvite ? (
            <Button onClick={() => setInviting(true)}>
              <Icon name="addUser" />
              Invite someone
            </Button>
          ) : null
        }
      >
        {failed ? (
          <Panel padding="none">
            <EmptyState
              icon={<Icon name="alert" />}
              title="Couldn't load your team"
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
            aria-label="Team"
            columns={personColumns}
            data={team?.people ?? []}
            loading={team === null}
            getRowId={(p) => p.userId}
          />
        )}
      </Section>

      {team?.invitations.length ? (
        <Section
          title="Waiting to join"
          description="They get an email with the link. You can also copy the link and send it yourself."
        >
          <DataTable
            aria-label="Waiting to join"
            density="compact"
            columns={inviteColumns}
            data={team.invitations}
            getRowId={(i) => i.id}
          />
        </Section>
      ) : null}

      {team ? (
        <AccessPanel
          team={team}
          person={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await Promise.all([load(), refresh()]);
          }}
        />
      ) : null}
      {team ? (
        <InviteModal
          team={team}
          open={inviting}
          myBranch={me.branches[0]?.id}
          onClose={() => setInviting(false)}
          onInvited={async (email) => {
            notify.success(`Invitation sent to ${email}`);
            setInviting(false);
            await load();
          }}
        />
      ) : null}
      {confirmElement}
    </div>
  );
}

function AccessPanel({
  team,
  person,
  onClose,
  onSaved,
}: {
  team: Team;
  person: TeamPerson | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (person) setGrants(person.grants.map((g) => ({ ...g })));
  }, [person]);
  const problem = grants.map(grantProblem).find(Boolean) ?? null;
  return (
    <SidePanel
      open={!!person}
      onOpenChange={(o) => !o && onClose()}
      width="md"
      title={person ? `What ${person.name} can do` : "Access"}
      description="Each role applies only in the branches and numbers picked for it."
      footer={
        <ModalActions
          start={problem ? <span className="text-[13px] text-muted-foreground">{problem}</span> : null}
        >
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving || !!problem}
            onClick={async () => {
              if (!person) return;
              setSaving(true);
              try {
                await api(`/team/${person.userId}/access`, { method: "PUT", json: { grants } });
                notify.success(`${person.name}'s access saved`);
                await onSaved();
              } catch (err) {
                notify.error(errorText(err, "Couldn't save their access. Try again."));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? <Icon name="loading" size="sm" /> : null}
            Save access
          </Button>
        </ModalActions>
      }
    >
      {grants.length ? (
        <AccessEditor value={grants} onChange={setGrants} {...team} disabled={saving} />
      ) : (
        <EmptyState
          size="sm"
          icon={<Icon name="lock" />}
          title="No access"
          description="They can sign in but can't see any branch."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setGrants([
                  emptyGrant(team.roles.find((r) => r.builtIn === "agent")?.id ?? "", team.branches[0]?.id),
                ])
              }
            >
              <Icon name="add" size="sm" />
              Give a role
            </Button>
          }
        />
      )}
    </SidePanel>
  );
}

function InviteModal({
  team,
  open,
  myBranch,
  onClose,
  onInvited,
}: {
  team: Team;
  open: boolean;
  myBranch?: string;
  onClose: () => void;
  onInvited: (email: string) => Promise<void>;
}) {
  const { branch } = useBranch();
  const start = () => [
    emptyGrant(
      team.roles.find((r) => r.builtIn === "agent")?.id ?? "",
      branch?.id ?? myBranch ?? team.branches[0]?.id,
    ),
  ];
  const [email, setEmail] = useState("");
  const [grants, setGrants] = useState<AccessGrant[]>(start);
  const [saving, setSaving] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time it opens
  useEffect(() => {
    if (open) {
      setEmail("");
      setGrants(start());
    }
  }, [open]);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const problem = !validEmail ? "Enter their email." : (grants.map(grantProblem).find(Boolean) ?? null);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Invite someone"
      description="They get an email with a link. Once they sign in, they have the access you pick here."
      footer={
        <ModalActions
          start={
            problem && email ? <span className="text-[13px] text-muted-foreground">{problem}</span> : null
          }
        >
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving || !!problem}
            onClick={async () => {
              setSaving(true);
              try {
                await api("/team/invitations", { method: "POST", json: { email: email.trim(), grants } });
                await onInvited(email.trim());
              } catch (err) {
                notify.error(errorText(err, "Couldn't send the invitation. Try again."));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? <Icon name="loading" size="sm" /> : <Icon name="send" size="sm" />}
            Send invitation
          </Button>
        </ModalActions>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Email" required>
          <TextInput
            type="email"
            autoComplete="off"
            placeholder="name@example.com"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <AccessEditor value={grants} onChange={setGrants} {...team} disabled={saving} />
      </div>
    </Modal>
  );
}
