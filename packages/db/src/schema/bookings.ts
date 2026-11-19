import type { BookingRange, BookingReminder } from "@relay/core/bookings";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { branch } from "./branches";
import { catalogItem, catalogVariant } from "./catalog";
import { contact, conversation, message } from "./messaging";
import { messageTemplate } from "./templates";

/*
 * Booking (Relay's own booking book): a branch's settings, its bookings, and the reminders sent.
 * A booking takes one place of a bookable service (catalog_variant.booking_capacity at once).
 */

/** One row per branch; no row means bookings are off (the defaults in @relay/core/bookings). */
export const bookingSetting = pgTable("booking_setting", {
  branchId: text("branch_id")
    .primaryKey()
    .references(() => branch.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  hours: jsonb("hours").$type<BookingRange[]>().notNull(),
  closedDates: text("closed_dates").array().notNull().default(sql`'{}'::text[]`),
  stepMinutes: integer("step_minutes").notNull().default(30),
  bufferMinutes: integer("buffer_minutes").notNull().default(0),
  minNoticeMinutes: integer("min_notice_minutes").notNull().default(60),
  maxDaysAhead: integer("max_days_ahead").notNull().default(30),
  reminders: jsonb("reminders").$type<BookingReminder[]>().notNull(),
  reminderTemplateId: text("reminder_template_id").references(() => messageTemplate.id, {
    onDelete: "set null",
  }),
  /** For online services (with a Meet link), when outside the 24-hour window. */
  onlineReminderTemplateId: text("online_reminder_template_id").references(() => messageTemplate.id, {
    onDelete: "set null",
  }),
  source: text("source").$type<"relay">().notNull().default("relay"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const bookingStatus = pgEnum("booking_status", [
  "booked",
  "confirmed",
  "arrived",
  "no_show",
  "cancelled",
]);
export const bookingBy = pgEnum("booking_by", ["ai", "team"]);

export const booking = pgTable(
  "booking",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    itemId: text("item_id").references(() => catalogItem.id, { onDelete: "set null" }),
    variantId: text("variant_id").references(() => catalogVariant.id, { onDelete: "set null" }),
    contactId: text("contact_id").references(() => contact.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversation.id, { onDelete: "set null" }),
    /** The service's name when booked ("Haircut", "Table · Terrace"). */
    title: text("title").notNull(),
    /** Short code the customer and team can quote ("K7P2QD"). */
    reference: text("reference").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    partySize: integer("party_size"),
    notes: text("notes").notNull().default(""),
    status: bookingStatus("status").notNull().default("booked"),
    bookedBy: bookingBy("booked_by").notNull(),
    bookedByUserId: text("booked_by_user_id").references(() => user.id, { onDelete: "set null" }),
    /** When the customer tapped Confirm on a reminder. */
    confirmedAt: timestamp("confirmed_at"),
    /** The event in the branch's Google Calendar, and its Meet link for online services. */
    externalEventId: text("external_event_id"),
    meetUrl: text("meet_url"),
    /** pending: Google has to be told (again); synced; failed (retried a few times). */
    calendarSync: text("calendar_sync").$type<"pending" | "synced" | "failed">().notNull().default("pending"),
    calendarError: text("calendar_error"),
    calendarAttempts: integer("calendar_attempts").notNull().default(0),
    calendarTriedAt: timestamp("calendar_tried_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("booking_branch_time_idx").on(t.organizationId, t.branchId, t.startsAt),
    index("booking_variant_time_idx").on(t.variantId, t.startsAt),
    index("booking_contact_idx").on(t.contactId, t.startsAt),
    uniqueIndex("booking_reference_uidx").on(t.organizationId, t.reference),
  ],
);

/** A reminder sent (or skipped) for a booking; one per booking and offset, so it's never sent twice. */
export const bookingReminder = pgTable(
  "booking_reminder",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "cascade" }),
    /** For which start time it was sent (a moved booking gets new reminders). */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    hoursBefore: real("hours_before").notNull(),
    /** sent | skipped (why in `note`). */
    outcome: text("outcome").$type<"sent" | "skipped">().notNull(),
    note: text("note"),
    messageId: text("message_id").references(() => message.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("booking_reminder_uidx").on(t.bookingId, t.startsAt, t.hoursBefore)],
);

/**
 * A branch's Google Calendar: the account, the chosen calendar (one it owns), and its tokens
 * (encrypted with CHANNEL_SECRET_KEY). Bookings go in as events; its busy times block bookings.
 */
export const calendarConnection = pgTable("calendar_connection", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  branchId: text("branch_id")
    .notNull()
    .unique()
    .references(() => branch.id, { onDelete: "cascade" }),
  provider: text("provider").$type<"google">().notNull().default("google"),
  accountEmail: text("account_email"),
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  calendarId: text("calendar_id"),
  calendarName: text("calendar_name"),
  /** The account's calendars it owns, as last read (to pick from). */
  calendars: jsonb("calendars")
    .$type<{ id: string; name: string; primary: boolean; timeZone: string | null }[]>()
    .notNull()
    .default([]),
  status: text("status")
    .$type<"pick_calendar" | "active" | "needs_reconnect">()
    .notNull()
    .default("pick_calendar"),
  lastError: text("last_error"),
  connectedByUserId: text("connected_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
