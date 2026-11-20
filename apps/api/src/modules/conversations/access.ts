import type { Permission } from "@relay/core/permissions";
import {
  type Access,
  can,
  chatScopes,
  companyPermissions,
  reachableBranchIds,
} from "@relay/core/permissions";
import {
  type AnyColumn,
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  loadCompanyAccess,
  or,
  type SQL,
  schema,
  sql,
} from "@relay/db";
import type { AppContext } from "../../context";

/*
 * Who sees and works on which conversations, from their grants (see @relay/core/permissions):
 * only branches and numbers a grant covers, and per grant every chat, theirs plus unassigned, or
 * only theirs. A conversation without a branch is seen only with "every chat" on everything.
 */

void companyPermissions;

/**
 * SQL for "rows whose branch and number this person holds `perm` on" (groups, broadcasts...).
 * Rows without a branch need the permission on everything.
 */
export function reachFilter(
  access: Access,
  perm: Permission,
  branchCol: AnyColumn,
  channelCol: AnyColumn,
): SQL {
  if (access.owner) return sql`true`;
  const parts: SQL[] = [];
  for (const g of access.grants) {
    if (!g.permissions.has(perm)) continue;
    if (!g.allBranches && g.branchIds.size === 0) continue;
    if (!g.allNumbers && g.numberIds.size === 0) continue;
    const branches = g.allBranches
      ? g.allNumbers
        ? undefined
        : isNotNull(branchCol)
      : inArray(branchCol, [...g.branchIds]);
    const numbers = g.allNumbers ? undefined : inArray(channelCol, [...g.numberIds]);
    parts.push(and(branches, numbers) ?? sql`true`);
  }
  return parts.length ? (or(...parts) as SQL) : sql`false`;
}

/** Branch ids the caller can reach, or null for "all". */
export async function reachableBranches(_ctx: AppContext, access: Access): Promise<string[] | null> {
  const r = reachableBranchIds(access);
  return r === "all" ? null : [...r];
}

const C = schema.conversation;

/** The SQL filter for "conversations this person may see" (optionally inside one branch). */
export function visibleTo(access: Access, branchId?: string | null): SQL {
  const inOrg = eq(C.organizationId, access.orgId);
  const inBranch = branchId ? eq(C.branchId, branchId) : undefined;
  if (access.owner) return and(inOrg, inBranch) as SQL;
  const parts: SQL[] = [];
  for (const g of access.grants) {
    const p = g.permissions;
    const see = p.has("chats.view_all")
      ? "all"
      : p.has("chats.view_unassigned")
        ? "unassigned"
        : p.has("chats.view")
          ? "own"
          : null;
    if (!see) continue;
    if (!g.allBranches && g.branchIds.size === 0) continue;
    if (!g.allNumbers && g.numberIds.size === 0) continue;
    const branches = g.allBranches
      ? g.allNumbers && see === "all"
        ? undefined
        : isNotNull(C.branchId)
      : inArray(C.branchId, [...g.branchIds]);
    const numbers = g.allNumbers ? undefined : inArray(C.channelAccountId, [...g.numberIds]);
    const who =
      see === "all"
        ? undefined
        : see === "unassigned"
          ? or(eq(C.assignedUserId, access.userId), isNull(C.assignedUserId))
          : eq(C.assignedUserId, access.userId);
    parts.push(and(branches, numbers, who) ?? sql`true`);
  }
  if (!parts.length) return sql`false`;
  return and(inOrg, inBranch, or(...parts)) as SQL;
}

/** Does this person only see some of the branch's chats (their own, or some numbers)? */
export function seesPartOf(access: Access, branchId: string) {
  const scopes = chatScopes(access, branchId);
  return !scopes.some((s) => s.numbers === "all" && s.see === "all");
}

export type Conversation = typeof schema.conversation.$inferSelect;

/** One conversation the caller may see, or null. Never reveals conversations of other companies. */
export async function findConversation(ctx: AppContext, access: Access, id: string) {
  const [row] = await ctx.db
    .select()
    .from(C)
    .where(and(eq(C.id, id), visibleTo(access)))
    .limit(1);
  return row ?? null;
}

const placeOf = (c: Pick<Conversation, "branchId" | "channelAccountId">) => ({
  branchId: c.branchId,
  channelId: c.channelAccountId,
});

/** Can the caller reply in (and take) this conversation, not just read it? */
export async function canWork(_ctx: AppContext, access: Access, conversation: Conversation) {
  return can(access, "chats.reply", placeOf(conversation));
}

/** Can the caller give this conversation to someone else, close or snooze it? */
export function canAssign(access: Access, conversation: Conversation) {
  return can(access, "chats.assign", placeOf(conversation));
}

/** Teammates a conversation can be assigned to: everyone who may reply on its branch and number. */
export async function assignableUsers(
  ctx: AppContext,
  organizationId: string,
  branchId: string | null,
  channelId?: string | null,
) {
  const everyone = await loadCompanyAccess(ctx.db, organizationId);
  const ids = everyone.filter((a) => can(a, "chats.reply", { branchId, channelId })).map((a) => a.userId);
  if (!ids.length) return [];
  return ctx.db
    .selectDistinct({ id: schema.user.id, name: schema.user.name, image: schema.user.image })
    .from(schema.user)
    .where(inArray(schema.user.id, ids))
    .orderBy(schema.user.name);
}
