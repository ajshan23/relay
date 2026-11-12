"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Person } from "@relay/ui/components/person";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { SidePanel } from "@relay/ui/components/side-panel";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Branch, type BranchMember, type BranchRole } from "@/lib/api";
import { useMe } from "@/lib/me";
import { listOrgMembers, type OrgMember } from "./org-members";
import { branchRoleLabel, branchRoleOptions, errorText, orgRoleLabel } from "./words";

export type BranchPeoplePanelProps = {
  branch: Branch | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after anyone is added, changed or removed, so the page can refetch counts. */
  onChanged: () => void | Promise<void>;
};

/** Who works in one branch, and (for owners, admins and the branch's managers) who to add or change. */
export function BranchPeoplePanel({ branch, open, onOpenChange, onChanged }: BranchPeoplePanelProps) {
  return (
    <SidePanel
      open={open && branch !== null}
      onOpenChange={onOpenChange}
      title={branch ? `People in ${branch.name}` : "People"}
      description="Owners and admins reach every branch. Everyone else only reaches the branches they are added to."
    >
      {branch ? <PeopleList key={branch.id} branch={branch} onChanged={onChanged} /> : null}
    </SidePanel>
  );
}

function PeopleList({ branch, onChanged }: { branch: Branch; onChanged: () => void | Promise<void> }) {
  const { me, canManageOrg, refresh } = useMe();
  const canManage = canManageOrg || branch.role === "manager";
  const [members, setMembers] = useState<BranchMember[] | null>(null);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [failed, setFailed] = useState(false);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await api<{ members: BranchMember[] }>(`/branches/${branch.id}/members`);
      setMembers(res.members);
    } catch {
      setFailed(true);
    }
    if (canManage) {
      try {
        setOrgMembers(await listOrgMembers());
      } catch {
        setOrgMembers([]);
      }
    }
  }, [branch.id, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterChange = async () => {
    await Promise.all([load(), refresh(), onChanged()]);
  };

  const changeRole = async (person: BranchMember, role: BranchRole) => {
    if (role === person.branchRole) return;
    setBusyUser(person.userId);
    try {
      await api(`/branches/${branch.id}/members/${person.userId}`, { method: "PUT", json: { role } });
      notify.success(`${person.name}: ${branchRoleLabel[role].toLowerCase()}`);
      await afterChange();
    } catch (err) {
      notify.error(errorText(err));
    } finally {
      setBusyUser(null);
    }
  };

  const remove = async (person: BranchMember) => {
    const ok = await confirm({
      title: `Take ${person.name} out of ${branch.name}?`,
      description:
        "They stop seeing this branch's chats and customers. They stay in your team and keep any other branches.",
      confirmLabel: "Take out of branch",
      tone: "danger",
    });
    if (!ok) return;
    setBusyUser(person.userId);
    try {
      await api(`/branches/${branch.id}/members/${person.userId}`, { method: "DELETE" });
      notify.success(`${person.name} taken out of ${branch.name}`);
      await afterChange();
    } catch (err) {
      notify.error(errorText(err));
    } finally {
      setBusyUser(null);
    }
  };

  if (failed) {
    return (
      <EmptyState
        size="sm"
        icon={<Icon name="alert" />}
        title="Couldn't load the people in this branch"
        action={
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!members) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const inBranch = new Set(members.map((m) => m.userId));
  const candidates = orgMembers.filter((m) => !inBranch.has(m.userId) && m.role === "member");

  return (
    <div className="flex flex-col gap-6">
      {canManage ? (
        <AddPerson
          candidates={candidates}
          canManageOrg={canManageOrg}
          onAdd={async (userId, role) => {
            const person = candidates.find((c) => c.userId === userId);
            try {
              await api(`/branches/${branch.id}/members/${userId}`, { method: "PUT", json: { role } });
              notify.success(`${person?.name ?? "They"} added to ${branch.name}`);
              await afterChange();
              return true;
            } catch (err) {
              notify.error(errorText(err));
              return false;
            }
          }}
        />
      ) : null}

      <ul className="flex flex-col divide-y divide-border">
        {members.map((person) => {
          const isMe = person.userId === me.user.id;
          const editable = canManage && !person.inherited && !isMe;
          const busy = busyUser === person.userId;
          return (
            <li key={person.userId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <Person name={person.name} src={person.image ?? undefined} size="md" decorative />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {person.name}
                  {isMe ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
                </p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {person.inherited ? "Reaches every branch" : person.email}
                </p>
              </div>
              {person.inherited ? (
                <Tag tone="primary" size="sm">
                  {orgRoleLabel[person.orgRole]}
                </Tag>
              ) : editable && person.branchRole ? (
                <div className="flex w-full items-center gap-1 sm:w-auto">
                  <SelectField
                    size="sm"
                    aria-label={`What ${person.name} can do here`}
                    value={person.branchRole}
                    options={branchRoleOptions}
                    disabled={busy}
                    onValueChange={(role) => void changeRole(person, role)}
                    className="flex-1 sm:w-48"
                  />
                  <IconButton
                    icon="close"
                    size="sm"
                    label={`Take ${person.name} out of this branch`}
                    disabled={busy}
                    onClick={() => void remove(person)}
                  />
                </div>
              ) : person.branchRole ? (
                <Tag size="sm">{branchRoleLabel[person.branchRole]}</Tag>
              ) : null}
            </li>
          );
        })}
      </ul>
      {confirmElement}
    </div>
  );
}

function AddPerson({
  candidates,
  canManageOrg,
  onAdd,
}: {
  candidates: OrgMember[];
  canManageOrg: boolean;
  onAdd: (userId: string, role: BranchRole) => Promise<boolean>;
}) {
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [role, setRole] = useState<BranchRole>("agent");
  const [adding, setAdding] = useState(false);
  // Radix Select keeps showing the last pick when its value goes back to undefined, so remount it on reset.
  const [resetKey, setResetKey] = useState(0);
  const options = useMemo(
    () => candidates.map((c) => ({ value: c.userId, label: c.name, description: c.email })),
    [candidates],
  );
  const selected = userId && candidates.some((c) => c.userId === userId) ? userId : undefined;

  if (candidates.length === 0) {
    return (
      <Panel padding="sm" className="bg-muted/50 text-[13px] text-muted-foreground">
        Everyone in your team who could join is already here.
        {canManageOrg ? (
          <>
            {" "}
            To add someone new, invite them from{" "}
            <Link
              href="/settings/team"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Team
            </Link>
            .
          </>
        ) : null}
      </Panel>
    );
  }

  return (
    <Panel padding="md" className="flex flex-col gap-3">
      <p className="text-sm font-semibold">Add someone</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Person">
          <SelectField
            key={resetKey}
            size="sm"
            value={selected}
            onValueChange={setUserId}
            options={options}
            placeholder="Pick someone"
          />
        </Field>
        <Field label="What they can do">
          <SelectField size="sm" value={role} onValueChange={setRole} options={branchRoleOptions} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!selected || adding}
          onClick={async () => {
            if (!selected) return;
            setAdding(true);
            const ok = await onAdd(selected, role);
            setAdding(false);
            if (ok) {
              setUserId(undefined);
              setResetKey((k) => k + 1);
            }
          }}
        >
          {adding ? <Icon name="loading" size="sm" /> : <Icon name="addUser" size="sm" />}
          Add to branch
        </Button>
      </div>
    </Panel>
  );
}
