import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { branch } from "./branches";

/**
 * A saved answer agents insert by typing "/" and its shortcut in the reply box. For the whole business
 * (branchId null) or one branch. Placeholders like {first_name} are filled in when inserted.
 */
export const quickReply = pgTable(
  "quick_reply",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id").references(() => branch.id, { onDelete: "cascade" }),
    /** Without the slash, lowercase: "timings". */
    shortcut: text("shortcut").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("quick_reply_shortcut_uidx").on(
      t.organizationId,
      sql`coalesce(${t.branchId}, '')`,
      sql`lower(${t.shortcut})`,
    ),
  ],
);
