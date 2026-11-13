import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { branch } from "./branches";
import { channelAccount } from "./channels";
import { contactIdentity } from "./messaging";

/*
 * Group chats, on any channel that has them. WhatsApp is the first; Instagram, Messenger, RCS and
 * others plug in through their channel adapter with no change here. Participants are contact
 * identities of the same channel, so a person can later be matched across channels.
 */

export const groupStatus = pgEnum("group_status", ["creating", "active", "suspended", "deleted", "failed"]);
export const participantStatus = pgEnum("group_participant_status", ["active", "left", "removed"]);
export const joinRequestStatus = pgEnum("group_join_request_status", [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
]);

export const channelGroup = pgTable(
  "channel_group",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    channelAccountId: text("channel_account_id")
      .notNull()
      .references(() => channelAccount.id, { onDelete: "cascade" }),
    branchId: text("branch_id").references(() => branch.id, { onDelete: "set null" }),
    /** The channel's id for the group. Null while it is being created (WhatsApp creates groups asynchronously). */
    externalId: text("external_id"),
    /** Correlates our create request with the channel's later answer. */
    requestId: text("request_id"),
    subject: text("subject"),
    description: text("description"),
    /** The link people use to join. Only returned by the invite-link endpoint, never in lists. */
    inviteLink: text("invite_link"),
    /** "approval_required" or "auto_approve" on WhatsApp; channel-defined elsewhere. */
    joinApprovalMode: text("join_approval_mode"),
    status: groupStatus("status").notNull().default("active"),
    statusReason: text("status_reason"),
    participantCount: integer("participant_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    uniqueIndex("channel_group_external_uidx").on(t.channelAccountId, t.externalId),
    uniqueIndex("channel_group_request_uidx").on(t.channelAccountId, t.requestId),
    index("channel_group_org_idx").on(t.organizationId, t.branchId),
  ],
);

/** Who is (or was) in a group. History stays when people leave or are removed. */
export const groupParticipant = pgTable(
  "group_participant",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => channelGroup.id, { onDelete: "cascade" }),
    contactIdentityId: text("contact_identity_id")
      .notNull()
      .references(() => contactIdentity.id, { onDelete: "cascade" }),
    status: participantStatus("status").notNull().default("active"),
    joinedAt: timestamp("joined_at").notNull().defaultNow(),
    leftAt: timestamp("left_at"),
  },
  (t) => [
    uniqueIndex("group_participant_uidx").on(t.groupId, t.contactIdentityId),
    index("group_participant_identity_idx").on(t.contactIdentityId),
  ],
);

/** Someone asked to join a group that needs approval. */
export const groupJoinRequest = pgTable(
  "group_join_request",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => channelGroup.id, { onDelete: "cascade" }),
    /** The channel's id for the request, used to approve or reject it. */
    externalId: text("external_id").notNull(),
    contactIdentityId: text("contact_identity_id")
      .notNull()
      .references(() => contactIdentity.id, { onDelete: "cascade" }),
    status: joinRequestStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    decidedAt: timestamp("decided_at"),
  },
  (t) => [uniqueIndex("group_join_request_uidx").on(t.groupId, t.externalId)],
);
