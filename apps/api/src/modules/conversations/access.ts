import { and, eq, inArray, or, schema, sql } from "@relay/db";
import type { AppContext } from "../../context";
import { type Access, isOrgAdmin } from "../branches/access";

/*
 * Who sees and works on which conversations. Owners and admins: every branch. Members: the branches
 * they are added to. A conversation without a branch is visible to owners and admins only.
 * Viewers can read; managers and agents can also reply, assign and close.
 */

/** Branch ids the caller can reach, or null for "all" (owners and admins). */
export async function reachableBranches(ctx: AppContext, access: Access): Promise<string[] | null> {
  if (isOrgAdmin(access.orgRole)) return null;
  const rows = await ctx.db
    .select({ id: schema.branchMember.branchId })
    .from(schema.branchMember)
    .where(
      and(
        eq(schema.branchMember.organizationId, access.orgId),
        eq(schema.branchMember.userId, access.userId),
      ),
    );
  return rows.map((r) => r.id);
}

export function visibleTo(access: Access, branches: string[] | null) {
  const inOrg = eq(schema.conversation.organizationId, access.orgId);
  if (branches === null) return inOrg;
  if (!branches.length) return sql`false`;
  return and(inOrg, inArray(schema.conversation.branchId, branches));
}

export type Conversation = typeof schema.conversation.$inferSelect;

/** One conversation the caller may see, or null. Never reveals conversations of other organizations. */
export async function findConversation(ctx: AppContext, access: Access, id: string) {
  const branches = await reachableBranches(ctx, access);
  const [row] = await ctx.db
    .select()
    .from(schema.conversation)
    .where(and(eq(schema.conversation.id, id), visibleTo(access, branches)))
    .limit(1);
  return row ?? null;
}

/** Can the caller reply to, assign and close this conversation (not just read it)? */
export async function canWork(ctx: AppContext, access: Access, conversation: Conversation) {
  if (isOrgAdmin(access.orgRole)) return true;
  if (!conversation.branchId) return false;
  const [row] = await ctx.db
    .select({ role: schema.branchMember.role })
    .from(schema.branchMember)
    .where(
      and(
        eq(schema.branchMember.branchId, conversation.branchId),
        eq(schema.branchMember.userId, access.userId),
      ),
    )
    .limit(1);
  return row?.role === "manager" || row?.role === "agent";
}

/** Teammates a conversation can be assigned to: owners, admins, and the branch's managers and agents. */
export async function assignableUsers(ctx: AppContext, organizationId: string, branchId: string | null) {
  const admins = and(
    eq(schema.member.organizationId, organizationId),
    inArray(schema.member.role, ["owner", "admin"]),
  );
  const branchPeople = branchId
    ? sql`${schema.user.id} in (select ${schema.branchMember.userId} from ${schema.branchMember}
        where ${schema.branchMember.branchId} = ${branchId} and ${schema.branchMember.role} in ('manager', 'agent'))`
    : sql`false`;
  return ctx.db
    .selectDistinct({ id: schema.user.id, name: schema.user.name, image: schema.user.image })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, organizationId), or(admins, branchPeople)))
    .orderBy(schema.user.name);
}
