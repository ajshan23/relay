import { newId } from "@relay/core";
import { type Access, canGrant } from "@relay/core/permissions";
import { and, eq, type GrantRow, inArray, isNull, rolePermissions, schema } from "@relay/db";
import { z } from "zod";
import type { AppContext } from "../../context";

/*
 * Saving someone's access: each grant is a role in some branches and some numbers. Everything is
 * checked here: the role is the company's, the branches are open, the numbers sit in those branches,
 * and the person saving can't hand out (or take away) more than they hold themselves.
 */

export const grantInput = z.object({
  roleId: z.string().min(1),
  /** Every branch, including ones added later. */
  allBranches: z.boolean().default(false),
  branchIds: z.array(z.string()).max(200).default([]),
  /** Every number in those branches, including ones added later. */
  allNumbers: z.boolean().default(true),
  numberIds: z.array(z.string()).max(500).default([]),
});
export type GrantInput = z.infer<typeof grantInput>;

type Problem = { ok: false; status: 403 | 404 | 409 | 422; code: string; message: string };
const problem = (status: Problem["status"], code: string, message: string): Problem => ({
  ok: false,
  status,
  code,
  message,
});

/** Checks grants and fills in each one's permissions. */
export async function checkGrants(ctx: AppContext, access: Access, inputs: GrantInput[]) {
  const roleIds = [...new Set(inputs.map((g) => g.roleId))];
  const roles = roleIds.length
    ? await ctx.db
        .select()
        .from(schema.role)
        .where(and(eq(schema.role.organizationId, access.orgId), inArray(schema.role.id, roleIds)))
    : [];
  const branches = await ctx.db
    .select({ id: schema.branch.id })
    .from(schema.branch)
    .where(and(eq(schema.branch.organizationId, access.orgId), isNull(schema.branch.archivedAt)));
  const numbers = await ctx.db
    .select({ id: schema.channelAccount.id, branchId: schema.channelAccount.branchId })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.organizationId, access.orgId));
  const out: (GrantInput & { permissions: ReturnType<typeof rolePermissions> })[] = [];
  for (const g of inputs) {
    const role = roles.find((r) => r.id === g.roleId);
    if (!role) return problem(422, "invalid_input", "Pick one of your roles.");
    const branchIds = g.allBranches ? [] : [...new Set(g.branchIds)];
    if (!g.allBranches && !branchIds.length)
      return problem(422, "invalid_input", "Pick at least one branch.");
    if (branchIds.some((b) => !branches.some((x) => x.id === b)))
      return problem(422, "invalid_input", "One of those branches doesn't exist.");
    const numberIds = g.allNumbers ? [] : [...new Set(g.numberIds)];
    if (!g.allNumbers && !numberIds.length) return problem(422, "invalid_input", "Pick at least one number.");
    for (const n of numberIds) {
      const num = numbers.find((x) => x.id === n);
      if (!num) return problem(422, "invalid_input", "One of those numbers doesn't exist.");
      if (!g.allBranches && !branchIds.includes(num.branchId))
        return problem(422, "invalid_input", "Pick numbers from the chosen branches only.");
    }
    const permissions = rolePermissions(role);
    const normal = {
      roleId: role.id,
      allBranches: g.allBranches,
      branchIds,
      allNumbers: g.allNumbers,
      numberIds,
    };
    if (!canGrant(access, { ...normal, permissions }))
      return problem(403, "forbidden", `You can't give ${role.name} there: it includes more than you have.`);
    out.push({ ...normal, permissions });
  }
  return { ok: true as const, grants: out };
}

/** Can the caller take this existing grant away (they hold everything it gives)? */
export async function canRemove(ctx: AppContext, access: Access, g: GrantRow) {
  const [role] = await ctx.db.select().from(schema.role).where(eq(schema.role.id, g.roleId)).limit(1);
  if (!role) return true;
  return canGrant(access, { ...g, permissions: rolePermissions(role) });
}

/** Replaces some of a person's grants with new ones, in one transaction. */
export async function saveGrants(
  ctx: AppContext,
  access: Access,
  userId: string,
  remove: GrantRow[],
  add: GrantInput[],
) {
  for (const g of remove)
    if (!(await canRemove(ctx, access, g)))
      return problem(403, "forbidden", "Their access includes more than you have, so you can't change it.");
  const checked = await checkGrants(ctx, access, add);
  if (!checked.ok) return checked;
  await ctx.db.transaction(async (tx) => {
    if (remove.length)
      await tx.delete(schema.memberGrant).where(
        inArray(
          schema.memberGrant.id,
          remove.map((g) => g.id),
        ),
      );
    if (checked.grants.length)
      await tx.insert(schema.memberGrant).values(
        checked.grants.map((g) => ({
          id: newId("memberGrant"),
          organizationId: access.orgId,
          userId,
          roleId: g.roleId,
          allBranches: g.allBranches,
          branchIds: g.branchIds,
          allNumbers: g.allNumbers,
          numberIds: g.numberIds,
          createdByUserId: access.userId,
        })),
      );
  });
  return { ok: true as const };
}

/** A person's grants in the company. */
export async function grantsOf(ctx: AppContext, orgId: string, userId: string) {
  return ctx.db
    .select()
    .from(schema.memberGrant)
    .where(and(eq(schema.memberGrant.organizationId, orgId), eq(schema.memberGrant.userId, userId)));
}
