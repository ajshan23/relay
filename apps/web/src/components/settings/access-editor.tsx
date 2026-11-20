"use client";

import { CheckboxRow, Segmented } from "@relay/ui/components/choice";
import { Field } from "@relay/ui/components/field";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Button } from "@relay/ui/ui/button";
import type { AccessGrant } from "@/lib/api";

/*
 * Someone's access: one or more roles, each in some branches and some numbers. Used when inviting
 * someone and when changing their access in Team.
 */

export type RoleOption = { id: string; name: string; builtIn: string | null };
export type BranchOption = { id: string; name: string };
export type NumberOption = { id: string; name: string; phone: string | null; branchId: string };

type Places = { roles: RoleOption[]; branches: BranchOption[]; numbers: NumberOption[] };

/** "Manager in Marina and JBR, 2 numbers". */
export function grantSummary(g: AccessGrant, places: Pick<Places, "roles" | "branches">) {
  const role = g.roleName ?? places.roles.find((r) => r.id === g.roleId)?.name ?? "Role";
  const names = g.branchIds.map((id) => places.branches.find((b) => b.id === id)?.name).filter(Boolean);
  const where = g.allBranches
    ? "every branch"
    : names.length <= 2
      ? names.join(" and ") || "no branch"
      : `${names.length} branches`;
  const numbers = g.allNumbers ? "" : `, ${g.numberIds.length} number${g.numberIds.length === 1 ? "" : "s"}`;
  return `${role} in ${where}${numbers}`;
}

export const emptyGrant = (roleId: string, branchId?: string): AccessGrant => ({
  roleId,
  allBranches: !branchId,
  branchIds: branchId ? [branchId] : [],
  allNumbers: true,
  numberIds: [],
});

/** What's missing before it can be saved, or null. */
export function grantProblem(g: AccessGrant) {
  if (!g.roleId) return "Pick a role.";
  if (!g.allBranches && !g.branchIds.length) return "Pick at least one branch.";
  if (!g.allNumbers && !g.numberIds.length) return "Pick at least one number.";
  return null;
}

export function AccessEditor({
  value,
  onChange,
  roles,
  branches,
  numbers,
  disabled,
}: Places & { value: AccessGrant[]; onChange: (next: AccessGrant[]) => void; disabled?: boolean }) {
  const set = (i: number, patch: Partial<AccessGrant>) =>
    onChange(value.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const defaultRole = roles.find((r) => r.builtIn === "agent")?.id ?? roles[0]?.id ?? "";
  return (
    <div className="flex flex-col gap-3">
      {value.map((g, i) => {
        const shownNumbers = numbers.filter((n) => g.allBranches || g.branchIds.includes(n.branchId));
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: grants have no id until saved, and keep their place
          <Panel key={i} padding="md" className="flex flex-col gap-4">
            <div className="flex items-end gap-2">
              <Field label="Role" className="flex-1">
                <SelectField
                  value={g.roleId || undefined}
                  placeholder="Pick a role"
                  disabled={disabled}
                  options={roles.map((r) => ({
                    value: r.id,
                    label: r.name,
                    description: r.builtIn ? "Built-in" : "Your own role",
                  }))}
                  onValueChange={(roleId) => set(i, { roleId })}
                />
              </Field>
              {value.length > 1 ? (
                <IconButton
                  icon="delete"
                  label="Remove this role"
                  disabled={disabled}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                />
              ) : null}
            </div>

            <fieldset className="flex flex-col gap-2" disabled={disabled}>
              <legend className="mb-2 text-sm font-medium">Branches</legend>
              <Segmented
                aria-label="Which branches"
                value={g.allBranches ? "all" : "some"}
                onChange={(v) =>
                  set(i, v === "all" ? { allBranches: true, branchIds: [] } : { allBranches: false })
                }
                options={[
                  { value: "all", label: "All branches" },
                  { value: "some", label: "Pick branches" },
                ]}
              />
              {g.allBranches ? (
                <p className="text-[13px] text-muted-foreground">Including branches you add later.</p>
              ) : (
                <div className="flex flex-col">
                  {branches.map((b) => (
                    <CheckboxRow
                      key={b.id}
                      label={b.name}
                      checked={g.branchIds.includes(b.id)}
                      onCheckedChange={(on) => {
                        const branchIds = on ? [...g.branchIds, b.id] : g.branchIds.filter((x) => x !== b.id);
                        // Numbers must sit in the chosen branches.
                        const numberIds = g.numberIds.filter((n) =>
                          branchIds.includes(numbers.find((x) => x.id === n)?.branchId ?? ""),
                        );
                        set(i, { branchIds, numberIds });
                      }}
                    />
                  ))}
                </div>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-2" disabled={disabled}>
              <legend className="mb-2 text-sm font-medium">Numbers</legend>
              <Segmented
                aria-label="Which numbers"
                value={g.allNumbers ? "all" : "some"}
                onChange={(v) =>
                  set(i, v === "all" ? { allNumbers: true, numberIds: [] } : { allNumbers: false })
                }
                options={[
                  { value: "all", label: "All numbers" },
                  { value: "some", label: "Pick numbers" },
                ]}
              />
              {g.allNumbers ? (
                <p className="text-[13px] text-muted-foreground">
                  Every number in {g.allBranches ? "every branch" : "those branches"}, including new ones.
                </p>
              ) : shownNumbers.length ? (
                <div className="flex flex-col">
                  {shownNumbers.map((n) => (
                    <CheckboxRow
                      key={n.id}
                      label={n.name}
                      description={[n.phone, branches.find((b) => b.id === n.branchId)?.name]
                        .filter(Boolean)
                        .join(" · ")}
                      checked={g.numberIds.includes(n.id)}
                      onCheckedChange={(on) =>
                        set(i, {
                          numberIds: on ? [...g.numberIds, n.id] : g.numberIds.filter((x) => x !== n.id),
                        })
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  Pick a branch first: its numbers show here.
                </p>
              )}
            </fieldset>
          </Panel>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !roles.length}
          onClick={() => onChange([...value, emptyGrant(defaultRole, branches[0]?.id)])}
        >
          <Icon name="add" size="sm" />
          Add another role
        </Button>
      </div>
    </div>
  );
}
