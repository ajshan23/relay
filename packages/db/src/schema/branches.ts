import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { storedFile } from "./messaging";

/** A branch is one location of an organization. Conversations, customers and campaigns belong to a branch. */
export const branch = pgTable(
  "branch",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    /** The branch's logo (a square image, at most 512 px), or null for its initials. */
    logoFileId: text("logo_file_id").references(() => storedFile.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    /** Set when a branch is closed. Its history stays; it no longer appears in pickers. */
    archivedAt: timestamp("archived_at"),
  },
  (t) => [
    uniqueIndex("branch_org_slug_uidx").on(t.organizationId, t.slug),
    index("branch_org_idx").on(t.organizationId),
  ],
);

/**
 * Who works in a branch, and as what. Organization owners and admins can reach every branch
 * without a row here; an ordinary member sees only the branches they are added to.
 */
export const branchMember = pgTable(
  "branch_member",
  {
    id: text("id").primaryKey(),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["manager", "agent", "viewer"] })
      .notNull()
      .default("agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("branch_member_branch_user_uidx").on(t.branchId, t.userId),
    index("branch_member_user_idx").on(t.userId),
  ],
);

export const branchRoles = ["manager", "agent", "viewer"] as const;
export type BranchRole = (typeof branchRoles)[number];
