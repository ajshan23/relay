import { newId } from "@relay/core";
import { type FieldOption, type FieldType, fieldKey, optionColours } from "@relay/core/contacts";
import { and, eq, inArray, isNull, schema, sql } from "@relay/db";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../../context";
import { type Access, type AccessEnv, fail, isOrgAdmin } from "../branches/access";
import type { ListsById } from "./filter";

/* Pieces the contacts routes, lists and imports share. */

type Db = AppContext["db"];

/** Keys the business's fields can't take: they name fixed columns. */
const reservedKeys = new Set([
  "name",
  "phone",
  "email",
  "tags",
  "branch",
  "marketing",
  "list",
  "created_at",
  "last_message_at",
]);

export const tidyOptions = (opts: Partial<FieldOption>[] | undefined): FieldOption[] =>
  (opts ?? []).map((o, i) => ({
    value: fieldKey(o.value || o.label || `option_${i + 1}`),
    label: o.label || o.value || `Option ${i + 1}`,
    colour: (optionColours as readonly string[]).includes(o.colour ?? "")
      ? (o.colour as string)
      : (optionColours[i % optionColours.length] ?? "gray"),
  }));

/** Adds a field at the end of the business's list; a second "Membership" gets the key membership_2. */
export async function createField(
  db: Db,
  orgId: string,
  userId: string | null,
  b: { label: string; type: FieldType; options?: Partial<FieldOption>[] },
) {
  const f = schema.contactField;
  const taken = new Set(
    (await db.select({ key: f.key }).from(f).where(eq(f.organizationId, orgId))).map((r) => r.key),
  );
  const base = fieldKey(b.label);
  let key = base;
  for (let i = 2; taken.has(key) || reservedKeys.has(key); i++) key = `${base}_${i}`;
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`coalesce(max(${f.position}), 0)::int` })
    .from(f)
    .where(eq(f.organizationId, orgId));
  const [row] = await db
    .insert(f)
    .values({
      id: newId("contactField"),
      organizationId: orgId,
      key,
      label: b.label,
      type: b.type,
      options: tidyOptions(b.options),
      position: n + 1,
      createdByUserId: userId,
    })
    .returning();
  if (!row) throw new Error("field insert returned nothing");
  return row;
}

/** True when the channel belongs to the business. */
export async function ownChannel(db: Db, orgId: string, channelAccountId: string) {
  const [row] = await db
    .select({ id: schema.channelAccount.id })
    .from(schema.channelAccount)
    .where(
      and(eq(schema.channelAccount.id, channelAccountId), eq(schema.channelAccount.organizationId, orgId)),
    )
    .limit(1);
  return !!row;
}

/**
 * Opts contacts out of marketing on one channel (or every channel when channelAccountId is null), or
 * back in. Opting back in on "every channel" clears all their opt-outs; on one channel, only that one.
 */
export async function setOptOut(
  db: Db,
  orgId: string,
  contactIds: string[],
  channelAccountId: string | null,
  optedOut: boolean,
  source: "reply" | "manual" | "import",
  userId: string | null,
) {
  if (!contactIds.length) return;
  const o = schema.contactOptOut;
  if (optedOut) {
    await db
      .insert(o)
      .values(
        contactIds.map((contactId) => ({
          id: newId("contactOptOut"),
          organizationId: orgId,
          contactId,
          channelAccountId,
          source,
          createdByUserId: userId,
        })),
      )
      .onConflictDoNothing();
    return;
  }
  await db
    .delete(o)
    .where(
      and(
        eq(o.organizationId, orgId),
        inArray(o.contactId, contactIds),
        channelAccountId ? eq(o.channelAccountId, channelAccountId) : undefined,
      ),
    );
}

/** Every list of the business, for filters that say "in list". */
export async function listsById(db: Db, orgId: string, branchId: string): Promise<ListsById> {
  const rows = await db
    .select({ id: schema.contactList.id, kind: schema.contactList.kind, filter: schema.contactList.filter })
    .from(schema.contactList)
    .where(and(eq(schema.contactList.organizationId, orgId), eq(schema.contactList.branchId, branchId)));
  return new Map(rows.map((r) => [r.id, { kind: r.kind, filter: r.filter }]));
}

/** The business's active fields, in order. */
export async function activeFields(db: Db, orgId: string) {
  return db
    .select()
    .from(schema.contactField)
    .where(and(eq(schema.contactField.organizationId, orgId), isNull(schema.contactField.archivedAt)))
    .orderBy(schema.contactField.position, schema.contactField.createdAt);
}

/** Requests that work inside one branch: contacts, lists, saved views and imports. */
export type BranchEnv = { Variables: AccessEnv["Variables"] & { branchId: string } };

/**
 * Contacts belong to a branch. Every request names the branch it's for (?branch=), and the caller must
 * be able to see it: owners and admins see every branch, everyone else only the branches they're in.
 */
export function requireBranch(ctx: AppContext): MiddlewareHandler<BranchEnv> {
  return async (c, next) => {
    const access = c.var.access;
    const id = c.req.query("branch");
    if (!id) return fail(c, 422, "branch_required", "Pick a branch.");
    const [found] = await ctx.db
      .select({ id: schema.branch.id })
      .from(schema.branch)
      .where(
        and(
          eq(schema.branch.id, id),
          eq(schema.branch.organizationId, access.orgId),
          isNull(schema.branch.archivedAt),
        ),
      )
      .limit(1);
    if (!found) return fail(c, 404, "branch_not_found", "That branch doesn't exist.");
    if (!isOrgAdmin(access.orgRole)) {
      const [member] = await ctx.db
        .select({ n: sql<number>`1` })
        .from(schema.branchMember)
        .where(and(eq(schema.branchMember.branchId, id), eq(schema.branchMember.userId, access.userId)))
        .limit(1);
      if (!member) return fail(c, 403, "forbidden", "You don't work in that branch.");
    }
    c.set("branchId", id);
    await next();
  };
}

/** Owners and admins, or the branch's managers and agents, may change its contacts. */
export async function canEditContacts(db: Db, access: Access, branchId: string) {
  if (isOrgAdmin(access.orgRole)) return true;
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(schema.branchMember)
    .where(
      and(
        eq(schema.branchMember.branchId, branchId),
        eq(schema.branchMember.userId, access.userId),
        inArray(schema.branchMember.role, ["manager", "agent"]),
      ),
    )
    .limit(1);
  return !!row;
}
