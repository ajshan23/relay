import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/** Business-wide rules for broadcasts. */
export type BroadcastRules = {
  /** At most this many marketing messages per person in 7 days, across broadcasts; null = no cap. */
  frequencyCap: number | null;
  /** Don't broadcast to people whose open chat is assigned to a teammate. */
  skipLiveChats: boolean;
};

export const defaultBroadcastRules: BroadcastRules = { frequencyCap: 2, skipLiveChats: true };

/** One row per organization for settings that don't belong to a channel or branch. */
export const organizationSettings = pgTable("organization_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  broadcast: jsonb("broadcast").$type<Partial<BroadcastRules>>().notNull().default({}),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
