import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { invitation, organization, user } from "./auth";

/*
 * Who may do what (see @relay/core/permissions). A company's roles are made of permissions; a grant
 * gives a person one role in some branches and some numbers. A person can hold several grants.
 * The owner (Better Auth's member.role "owner") needs no grant.
 */

/** A role: the four built-in ones (permissions from code) plus the company's own. */
export const role = pgTable(
  "role",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** admin | manager | agent | viewer for the built-in roles (their permissions come from code). */
    builtIn: text("built_in", { enum: ["admin", "manager", "agent", "viewer"] }),
    /** Permission keys, for the company's own roles. */
    permissions: text("permissions").array().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("role_org_name_uidx").on(t.organizationId, t.name),
    uniqueIndex("role_org_builtin_uidx").on(t.organizationId, t.builtIn),
  ],
);

/** One role given to a person, in some branches and some numbers. */
export const memberGrant = pgTable(
  "member_grant",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "restrict" }),
    /** Every branch, including ones added later. Otherwise branchIds. */
    allBranches: boolean("all_branches").notNull().default(false),
    branchIds: text("branch_ids").array().notNull().default([]),
    /** Every number in those branches, including ones added later. Otherwise numberIds. */
    allNumbers: boolean("all_numbers").notNull().default(true),
    numberIds: text("number_ids").array().notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("member_grant_org_user_idx").on(t.organizationId, t.userId),
    index("member_grant_role_idx").on(t.roleId),
  ],
);

/** Access chosen when inviting someone, given to them when they accept. */
export const invitationGrant = pgTable(
  "invitation_grant",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitation.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
    allBranches: boolean("all_branches").notNull().default(false),
    branchIds: text("branch_ids").array().notNull().default([]),
    allNumbers: boolean("all_numbers").notNull().default(true),
    numberIds: text("number_ids").array().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("invitation_grant_invitation_idx").on(t.invitationId)],
);
