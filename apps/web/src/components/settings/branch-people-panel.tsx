"use client";

import { CheckboxRow, Segmented } from "@relay/ui/components/choice";
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
import { api, type Branch, type BranchMember } from "@/lib/api";
import { useMe } from "@/lib/me";
import { listOrgMembers, type OrgMember } from "./org-members";
import { errorText } from "./words";

type RoleOption = { id: string; name: string; builtIn: string | null };
type NumberOption = { id: string; name: string; phone: string | null };
type Choice = { roleId: string; allNumbers: boolean; numberIds: string[] };

export type BranchPeoplePanelProps = {
  branch: Branch | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after anyone is added, changed or removed, so the page can refetch counts. */
  onChanged: () => void | Promise<void>;
};

/** Who works in one branch, and (for people who may) who to add or change. */
export function BranchPeoplePanel({ branch, open, onOpenChange, onChanged }: BranchPeoplePanelProps) {
  return (
    <SidePanel
      open={open && branch !== null}
      onOpenChange={onOpenChange}
      width="md"
      title={branch ? `People in ${branch.name}` : "People"}
      description="Each person's role here decides what they can do in this branch, on all its numbers or the ones picked."
    >
      {branch ? <PeopleList key={branch.id} branch={branch} onChanged={onChanged} /> : null}
    </SidePanel>
  );
}

/** Role and numbers for one person in this branch. */
function ChoiceFields({
  value,
  onChange,
  roles,
  numbers,
}: {
  value: Choice;
  onChange: (c: Choice) => void;
  roles: RoleOption[];
  numbers: NumberOption[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Role">
        <SelectField
          size="sm"
          value={value.roleId || undefined}
          placeholder="Pick a role"
          options={roles.map((r) => ({ value: r.id, label: r.name }))}
          onValueChange={(roleId) => onChange({ ...value, roleId })}
        />
      </Field>
      {numbers.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Numbers</legend>
          <Segmented
            aria-label="Which numbers"
            value={value.allNumbers ? "all" : "some"}
            onChange={(v) =>
              onChange({ ...value, allNumbers: v === "all", numberIds: v === "all" ? [] : value.numberIds })
            }
            options={[
              { value: "all", label: "All numbers" },
              { value: "some", label: "Pick numbers" },
            ]}
          />
          {!value.allNumbers
            ? numbers.map((n) => (
                <CheckboxRow
                  key={n.id}
                  label={n.name}
                  description={n.phone ?? undefined}
                  checked={value.numberIds.includes(n.id)}
                  onCheckedChange={(on) =>
                    onChange({
                      ...value,
                      numberIds: on ? [...value.numberIds, n.id] : value.numberIds.filter((x) => x !== n.id),
                    })
                  }
                />
              ))
            : null}
        </fieldset>
      ) : null}
    </div>
  );
}

const choiceProblem = (c: Choice) =>
  !c.roleId ? "Pick a role." : !c.allNumbers && !c.numberIds.length ? "Pick at least one number." : null;

function PeopleList({ branch, onChanged }: { branch: Branch; onChanged: () => void | Promise<void> }) {
  const { me, refresh, canManageOrg } = useMe();
  const [data, setData] = useState<{
    members: BranchMember[];
    roles: RoleOption[];
    numbers: NumberOption[];
    canManage: boolean;
  } | null>(null);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [failed, setFailed] = useState(false);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ userId: string; choice: Choice } | null>(null);
  const [confirm, confirmElement] = useConfirm();

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await api<NonNullable<typeof data>>(`/branches/${branch.id}/members`);
      setData(res);
      if (res.canManage) setOrgMembers(await listOrgMembers().catch(() => []));
    } catch {
      setFailed(true);
    }
  }, [branch.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterChange = async () => {
    await Promise.all([load(), refresh(), onChanged()]);
  };

  const save = async (userId: string, name: string, choice: Choice, verb: string) => {
    setBusyUser(userId);
    try {
      await api(`/branches/${branch.id}/members/${userId}`, { method: "PUT", json: choice });
      notify.success(`${name} ${verb}`);
      setEditing(null);
      await afterChange();
      return true;
    } catch (err) {
      notify.error(errorText(err));
      return false;
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

  if (!data) {
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

  const { members, roles, numbers, canManage } = data;
  const inBranch = new Set(members.map((m) => m.userId));
  const candidates = orgMembers.filter((m) => !inBranch.has(m.userId) && m.role !== "owner");
  const numbersLabel = (p: BranchMember) => {
    const g = p.grants.find((x) => !x.allNumbers);
    if (!g) return null;
    const here = g.numberIds.filter((id) => numbers.some((n) => n.id === id));
    return here.length === 1
      ? (numbers.find((n) => n.id === here[0])?.name ?? "1 number")
      : `${here.length} numbers`;
  };

  return (
    <div className="flex flex-col gap-6">
      {canManage ? (
        <AddPerson
          candidates={candidates}
          roles={roles}
          numbers={numbers}
          canManageOrg={canManageOrg}
          onAdd={(userId, choice) =>
            save(
              userId,
              candidates.find((c) => c.userId === userId)?.name ?? "They",
              choice,
              `added to ${branch.name}`,
            )
          }
        />
      ) : null}

      <ul className="flex flex-col divide-y divide-border">
        {members.map((person) => {
          const isMe = person.userId === me.user.id;
          const editable = canManage && !person.inherited && !isMe;
          const busy = busyUser === person.userId;
          const open = editing?.userId === person.userId;
          const nums = numbersLabel(person);
          return (
            <li key={person.userId} className="flex flex-col gap-3 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Person name={person.name} src={person.image ?? undefined} size="md" decorative />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {person.name}
                    {isMe ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {person.inherited
                      ? person.owner
                        ? "Owner: reaches every branch"
                        : "Access set in Team (several branches)"
                      : person.email}
                  </p>
                </div>
                <Tag tone={person.inherited ? "primary" : "plain"} size="sm">
                  {person.role}
                  {nums ? ` · ${nums}` : ""}
                </Tag>
                {editable && !open ? (
                  <div className="flex items-center gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const g = person.grants[0];
                        setEditing({
                          userId: person.userId,
                          choice: {
                            roleId: g?.roleId ?? "",
                            allNumbers: g?.allNumbers ?? true,
                            numberIds: g?.numberIds.filter((id) => numbers.some((n) => n.id === id)) ?? [],
                          },
                        });
                      }}
                    >
                      Change
                    </Button>
                    <IconButton
                      icon="close"
                      size="sm"
                      label={`Take ${person.name} out of this branch`}
                      disabled={busy}
                      onClick={() => void remove(person)}
                    />
                  </div>
                ) : null}
              </div>
              {open && editing ? (
                <Panel padding="md" className="flex flex-col gap-3">
                  <ChoiceFields
                    value={editing.choice}
                    onChange={(choice) => setEditing({ ...editing, choice })}
                    roles={roles}
                    numbers={numbers}
                  />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !!choiceProblem(editing.choice)}
                      onClick={() => void save(person.userId, person.name, editing.choice, "changed")}
                    >
                      Save
                    </Button>
                  </div>
                </Panel>
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
  roles,
  numbers,
  canManageOrg,
  onAdd,
}: {
  candidates: OrgMember[];
  roles: RoleOption[];
  numbers: NumberOption[];
  canManageOrg: boolean;
  onAdd: (userId: string, choice: Choice) => Promise<boolean>;
}) {
  const agentRole = roles.find((r) => r.builtIn === "agent")?.id ?? roles[0]?.id ?? "";
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [choice, setChoice] = useState<Choice>({ roleId: agentRole, allNumbers: true, numberIds: [] });
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
      <ChoiceFields value={choice} onChange={setChoice} roles={roles} numbers={numbers} />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!selected || adding || !!choiceProblem(choice)}
          onClick={async () => {
            if (!selected) return;
            setAdding(true);
            const ok = await onAdd(selected, choice);
            setAdding(false);
            if (ok) {
              setUserId(undefined);
              setChoice({ roleId: agentRole, allNumbers: true, numberIds: [] });
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
