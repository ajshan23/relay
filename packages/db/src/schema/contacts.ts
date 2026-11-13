import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { branch } from "./branches";
import { channelAccount } from "./channels";
import { contact } from "./messaging";

/*
 * Contacts around the core `contact` row (messaging.ts): the business's own fields (values live in
 * contact.attributes), tags (ids live in contact.tag_ids), notes, lists, saved table views and imports.
 */

export const fieldType = pgEnum("contact_field_type", [
  "text",
  "number",
  "date",
  "boolean",
  "select",
  "multi_select",
  "email",
  "phone",
  "url",
]);

/** One of the business's own contact fields. Its values are stored in contact.attributes[key]. */
export const contactField = pgTable(
  "contact_field",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Stable key in contact.attributes, e.g. "date_of_birth". Never changes, even when renamed. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: fieldType("type").notNull(),
    /** Choice fields: [{ value, label, colour }]. */
    options: jsonb("options")
      .$type<{ value: string; label: string; colour: string }[]>()
      .notNull()
      .default([]),
    position: integer("position").notNull().default(0),
    /** True once a typed index exists for sorting and range filters on this field. */
    indexed: boolean("indexed").notNull().default(false),
    archivedAt: timestamp("archived_at"),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contact_field_key_uidx").on(t.organizationId, t.key)],
);

/**
 * A label for contacts. Scoped to the whole business, or to one branch and/or one channel account.
 * Contacts hold tag ids in contact.tag_ids.
 */
export const tag = pgTable(
  "tag",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Null: every branch. */
    branchId: text("branch_id").references(() => branch.id, { onDelete: "cascade" }),
    /** Null: every channel. */
    channelAccountId: text("channel_account_id").references(() => channelAccount.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    colour: text("colour").notNull().default("gray"),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tag_name_scope_uidx").on(
      t.organizationId,
      sql`lower(${t.name})`,
      sql`coalesce(${t.branchId}, '')`,
      sql`coalesce(${t.channelAccountId}, '')`,
    ),
  ],
);

export const contactNote = pgTable(
  "contact_note",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("contact_note_contact_idx").on(t.contactId, t.createdAt)],
);

export const optOutSource = pgEnum("contact_opt_out_source", ["reply", "manual", "import"]);

/**
 * "Don't send me marketing" for one channel account (a WhatsApp number, an email sender...), or for
 * every channel when channel_account_id is null. Service messages (reminders, replies) still go out.
 * Broadcasts skip a contact opted out on the sending channel or on all channels.
 */
export const contactOptOut = pgTable(
  "contact_opt_out",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Null: every channel. */
    channelAccountId: text("channel_account_id").references(() => channelAccount.id, { onDelete: "cascade" }),
    /** reply: they wrote STOP; manual: a teammate; import: a spreadsheet column. */
    source: optOutSource("source").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contact_opt_out_scope_uidx").on(t.contactId, sql`coalesce(${t.channelAccountId}, '')`),
    index("contact_opt_out_org_channel_idx").on(t.organizationId, t.channelAccountId),
  ],
);

export const listKind = pgEnum("contact_list_kind", ["static", "smart"]);

/** A group of contacts to send broadcasts to: picked by hand (static) or a saved filter (smart). */
export const contactList = pgTable(
  "contact_list",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: listKind("kind").notNull(),
    /** Smart lists: the filter (same shape as the contacts table filter). */
    filter: jsonb("filter").$type<Record<string, unknown>>(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contact_list_name_uidx").on(t.organizationId, sql`lower(${t.name})`)],
);

export const contactListMember = pgTable(
  "contact_list_member",
  {
    listId: text("list_id")
      .notNull()
      .references(() => contactList.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.contactId] }),
    index("contact_list_member_contact_idx").on(t.contactId),
  ],
);

/** A saved way of looking at the contacts table: columns, widths, filters and sort. */
export const contactView = pgTable(
  "contact_view",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Null: shared with the whole business. */
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("contact_view_org_idx").on(t.organizationId, t.ownerUserId)],
);

export const importStatus = pgEnum("contact_import_status", [
  "mapping",
  "queued",
  "running",
  "done",
  "failed",
]);

/** An Excel or CSV import: the uploaded file, how its columns map to fields, and the outcome. */
export const contactImport = pgTable(
  "contact_import",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    sheet: text("sheet"),
    /** Column header → target: { kind: "core"|"field"|"tags"|"new_field"|"skip", ... }. */
    mapping: jsonb("mapping").$type<Record<string, unknown>>(),
    /** Match existing contacts by phone or email: update them, or skip those rows. */
    onMatch: text("on_match").notNull().default("update"),
    status: importStatus("status").notNull().default("mapping"),
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    /** The first rows that failed, with why and their cells: [{ row, reason, values }]. */
    errors: jsonb("errors")
      .$type<{ row: number; reason: string; values?: unknown[] }[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("contact_import_org_idx").on(t.organizationId, t.createdAt)],
);
