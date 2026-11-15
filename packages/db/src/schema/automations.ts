import type { AutomationDefinition } from "@relay/core/automations";
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { branch } from "./branches";
import { channelAccount } from "./channels";

/*
 * Automations: one trigger on one number of one branch, then steps. The editor changes only `draft`;
 * publishing validates it and freezes a numbered automation_version that runs are pinned to, so a run
 * that is waiting for a reply finishes on the steps it started with.
 *
 * Runs themselves live in Kairos (schema "kairos", labelled with the automation id), not here.
 * The routing columns copy the live version's trigger so the worker finds candidates with an index
 * instead of reading every definition.
 */

export const automationStatus = pgEnum("automation_status", ["draft", "live", "paused", "archived"]);

export const automation = pgTable(
  "automation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** The WhatsApp number the trigger listens on; every step sends from it. */
    channelAccountId: text("channel_account_id").references(() => channelAccount.id, {
      onDelete: "set null",
    }),
    status: automationStatus("status").notNull().default("draft"),
    draft: jsonb("draft").$type<AutomationDefinition>().notNull(),
    /** Bumped by every draft save; a save with an older revision is refused (two editors). */
    draftRevision: integer("draft_revision").notNull().default(1),
    liveVersionId: text("live_version_id"),
    /** From the live version, for routing: message_received | ad_click | tag_added | run_from_chat. */
    triggerType: text("trigger_type"),
    /** From the live version: keyword, first message… (higher wins when two match one message). */
    priority: integer("priority").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("automation_branch_idx").on(t.organizationId, t.branchId, t.updatedAt),
    // The router's lookup: live automations of one number and trigger kind.
    index("automation_route_idx").on(t.channelAccountId, t.triggerType, t.status),
  ],
);

export const automationVersion = pgTable(
  "automation_version",
  {
    id: text("id").primaryKey(),
    automationId: text("automation_id")
      .notNull()
      .references(() => automation.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    definition: jsonb("definition").$type<AutomationDefinition>().notNull(),
    /** sha256 of the definition, to tell whether the draft has unpublished changes. */
    checksum: text("checksum").notNull(),
    publishedByUserId: text("published_by_user_id").references(() => user.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("automation_version_number_uidx").on(t.automationId, t.number)],
);
