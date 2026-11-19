import {
  activeBookingStatuses,
  type BookingSettings,
  type BookingStatus,
  bookingLimits,
  bookingTimeLabel,
  defaultBookingSettings,
  fits,
  freeTimes,
  isOfferedTime,
  localTime,
  nextDate,
  overlapsAny,
  zonedTime,
} from "@relay/core/bookings";
import { and, asc, eq, gt, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { type CalendarDeps, googleBusy, syncBooking } from "./booking-calendar";
import type { createDb } from "./client";
import { booking, bookingSetting, branch, catalogItem, catalogVariant } from "./schema";

/*
 * Relay's own booking book: settings, free times, and booking a place safely. Shared by the API (the
 * team's Bookings page) and the worker (Mira), so both book the same way.
 *
 * A place is taken inside one transaction that first locks the service (pg_advisory_xact_lock), then
 * counts what overlaps, so two customers can never get the last table at the same moment.
 */

type Db = ReturnType<typeof createDb>["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type BranchBooking = BookingSettings & { timezone: string };

/** A branch's booking settings (the defaults, switched off, when it has none) and its timezone. */
export async function bookingSettingsOf(
  db: Db | Tx,
  organizationId: string,
  branchId: string,
): Promise<BranchBooking> {
  const [b] = await db
    .select({ timezone: branch.timezone })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.organizationId, organizationId)))
    .limit(1);
  const [s] = await db
    .select()
    .from(bookingSetting)
    .where(and(eq(bookingSetting.branchId, branchId), eq(bookingSetting.organizationId, organizationId)))
    .limit(1);
  const timezone = b?.timezone || "UTC";
  if (!s) return { ...defaultBookingSettings, timezone };
  return {
    enabled: s.enabled,
    hours: s.hours,
    closedDates: s.closedDates,
    stepMinutes: s.stepMinutes,
    bufferMinutes: s.bufferMinutes,
    minNoticeMinutes: s.minNoticeMinutes,
    maxDaysAhead: s.maxDaysAhead,
    reminders: s.reminders,
    reminderTemplateId: s.reminderTemplateId,
    onlineReminderTemplateId: s.onlineReminderTemplateId,
    source: s.source,
    timezone,
  };
}

export async function saveBookingSettings(
  db: Db,
  organizationId: string,
  branchId: string,
  settings: BookingSettings,
): Promise<void> {
  const values = { ...settings, updatedAt: new Date() };
  await db
    .insert(bookingSetting)
    .values({ branchId, organizationId, ...values })
    .onConflictDoUpdate({ target: bookingSetting.branchId, set: values });
}

export type BookableService = {
  itemId: string;
  variantId: string;
  /** "Haircut" or "Haircut · Long hair". */
  title: string;
  durationMinutes: number;
  capacity: number;
};

/** The branch's services that can be booked: active items, available variants with a length. */
export async function bookableServices(
  db: Db | Tx,
  q: { organizationId: string; branchId: string; variantIds?: string[] },
): Promise<BookableService[]> {
  const rows = await db
    .select({
      itemId: catalogItem.id,
      variantId: catalogVariant.id,
      item: catalogItem.title,
      variant: catalogVariant.title,
      durationMinutes: catalogVariant.durationMinutes,
      capacity: catalogVariant.bookingCapacity,
    })
    .from(catalogVariant)
    .innerJoin(catalogItem, eq(catalogItem.id, catalogVariant.itemId))
    .where(
      and(
        eq(catalogVariant.organizationId, q.organizationId),
        eq(catalogVariant.branchId, q.branchId),
        eq(catalogVariant.bookable, true),
        eq(catalogVariant.available, true),
        gt(catalogVariant.durationMinutes, 0),
        eq(catalogItem.status, "active"),
        ...(q.variantIds ? [inArray(catalogVariant.id, q.variantIds.length ? q.variantIds : [""])] : []),
      ),
    )
    .orderBy(asc(catalogItem.title), asc(catalogVariant.position))
    .limit(500);
  return rows.map((r) => ({
    itemId: r.itemId,
    variantId: r.variantId,
    title: r.variant ? `${r.item} · ${r.variant}` : r.item,
    durationMinutes: r.durationMinutes ?? 0,
    capacity: Math.max(1, r.capacity),
  }));
}

/** Bookings that take a place of a service and overlap [from, to) (with a margin for the gap). */
async function busyFor(db: Db | Tx, variantId: string, from: Date, to: Date, exceptId?: string) {
  const margin = 24 * 3_600_000;
  const rows = await db
    .select({ start: booking.startsAt, end: booking.endsAt })
    .from(booking)
    .where(
      and(
        eq(booking.variantId, variantId),
        inArray(booking.status, activeBookingStatuses),
        lt(booking.startsAt, new Date(to.getTime() + margin)),
        gt(booking.endsAt, new Date(from.getTime() - margin)),
        ...(exceptId ? [ne(booking.id, exceptId)] : []),
      ),
    );
  return rows.map((r) => ({ start: r.start, end: r.end }));
}

/** Free start times of one service between two instants. */
export async function findTimes(
  db: Db | Tx,
  q: {
    organizationId: string;
    branchId: string;
    variantId: string;
    from: Date;
    to: Date;
    now: Date;
    limit?: number;
    /** Moving a booking: don't count it against itself. */
    exceptBookingId?: string;
    /** The branch's Google Calendar: its busy times close those times. */
    calendar?: CalendarDeps | null;
  },
): Promise<
  | { ok: true; service: BookableService; times: Date[]; timezone: string }
  | { ok: false; reason: "off" | "not_bookable" }
> {
  const settings = await bookingSettingsOf(db, q.organizationId, q.branchId);
  if (!settings.enabled) return { ok: false, reason: "off" };
  const [service] = await bookableServices(db, { ...q, variantIds: [q.variantId] });
  if (!service) return { ok: false, reason: "not_bookable" };
  const busy = await busyFor(db, q.variantId, q.from, q.to, q.exceptBookingId);
  const blocked = await googleBusy(db as Db, q.calendar, q);
  const times = freeTimes({
    blocked,
    settings,
    timezone: settings.timezone,
    durationMinutes: service.durationMinutes,
    capacity: service.capacity,
    busy,
    from: q.from,
    to: q.to,
    now: q.now,
    ...(q.limit ? { limit: q.limit } : {}),
  });
  return { ok: true, service, times, timezone: settings.timezone };
}

const refChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A short code without look-alike letters ("K7P2QD"). */
export function bookingReference(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += refChars[Math.floor(Math.random() * refChars.length)];
  return out;
}

export type BookingRow = typeof booking.$inferSelect;
export type BookResult =
  | { ok: true; booking: BookingRow; label: string; meetUrl: string | null }
  | { ok: false; reason: "off" | "not_bookable" | "not_offered" | "taken" | "busy" | "not_found" };

/** Plain words for a failed booking, for the agent and the team. */
export const bookingProblem: Record<Exclude<BookResult, { ok: true }>["reason"], string> = {
  off: "The business isn't taking bookings right now.",
  not_bookable: "That service can't be booked.",
  not_offered: "That time isn't one the business offers (outside opening hours, too soon or too far ahead).",
  taken: "That time was just taken.",
  busy: "That time is busy in the business's calendar.",
  not_found: "That booking wasn't found.",
};

async function lockService(tx: Tx, variantId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${variantId}`}))`);
}

/**
 * Books one place. The team may book outside the offered times (`anyTime`); the agent may not. The
 * time is checked again under the lock, so a place is never given twice.
 */
export async function createBooking(
  db: Db,
  input: {
    id: string;
    organizationId: string;
    branchId: string;
    variantId: string;
    startsAt: Date;
    contactId: string | null;
    conversationId: string | null;
    partySize?: number | null;
    notes?: string;
    bookedBy: "ai" | "team";
    userId?: string | null;
    now: Date;
    anyTime?: boolean;
    calendar?: CalendarDeps | null;
  },
): Promise<BookResult> {
  // Busy in Google Calendar (read before the lock: no network inside it). The team may book anyway.
  const blocked = input.anyTime
    ? []
    : await googleBusy(db, input.calendar, {
        ...input,
        from: input.startsAt,
        to: new Date(input.startsAt.getTime() + 86_400_000),
      });
  const res = await db.transaction(async (tx) => {
    const settings = await bookingSettingsOf(tx, input.organizationId, input.branchId);
    if (!settings.enabled && input.bookedBy === "ai") return { ok: false, reason: "off" } as const;
    const [service] = await bookableServices(tx, { ...input, variantIds: [input.variantId] });
    if (!service) return { ok: false, reason: "not_bookable" } as const;
    const offered = {
      settings,
      timezone: settings.timezone,
      durationMinutes: service.durationMinutes,
      capacity: service.capacity,
      now: input.now,
    };
    if (!input.anyTime && !isOfferedTime(offered, input.startsAt))
      return { ok: false, reason: "not_offered" } as const;
    await lockService(tx, input.variantId);
    const endsAt = new Date(input.startsAt.getTime() + service.durationMinutes * 60_000);
    if (overlapsAny(input.startsAt, endsAt, blocked)) return { ok: false, reason: "busy" } as const;
    const busy = await busyFor(tx, input.variantId, input.startsAt, endsAt);
    if (!fits(input.startsAt, endsAt, busy, service.capacity, settings.bufferMinutes))
      return { ok: false, reason: "taken" } as const;
    let row: BookingRow | undefined;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      [row] = await tx
        .insert(booking)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          branchId: input.branchId,
          itemId: service.itemId,
          variantId: service.variantId,
          contactId: input.contactId,
          conversationId: input.conversationId,
          title: service.title,
          reference: bookingReference(),
          startsAt: input.startsAt,
          endsAt,
          partySize: input.partySize ?? null,
          notes: input.notes ?? "",
          bookedBy: input.bookedBy,
          bookedByUserId: input.userId ?? null,
        })
        .onConflictDoNothing({ target: [booking.organizationId, booking.reference] })
        .returning();
    }
    if (!row) throw new Error("Couldn't make a booking reference");
    return {
      ok: true,
      booking: row,
      label: bookingTimeLabel(row.startsAt, settings.timezone),
      meetUrl: null,
    } as const;
  });
  return afterChange(db, res, input.calendar);
}

/** Puts a booking change into Google Calendar (after the commit), with the Meet link it got. */
async function afterChange(
  db: Db,
  res: BookResult,
  calendar: CalendarDeps | null | undefined,
): Promise<BookResult> {
  if (!res.ok || !calendar) return res;
  const synced = await syncBooking(db, calendar, res.booking.id);
  return { ...res, meetUrl: synced.meetUrl };
}

/** Moves a booking to another start (rechecked like a new one). Its reminders follow the new time. */
export async function moveBooking(
  db: Db,
  input: {
    organizationId: string;
    bookingId: string;
    startsAt: Date;
    now: Date;
    anyTime?: boolean;
    contactId?: string;
    calendar?: CalendarDeps | null;
  },
): Promise<BookResult> {
  const [current] = await db
    .select({ branchId: booking.branchId })
    .from(booking)
    .where(and(eq(booking.id, input.bookingId), eq(booking.organizationId, input.organizationId)))
    .limit(1);
  const blocked =
    input.anyTime || !current
      ? []
      : await googleBusy(db, input.calendar, {
          organizationId: input.organizationId,
          branchId: current.branchId,
          from: input.startsAt,
          to: new Date(input.startsAt.getTime() + 86_400_000),
        });
  const res = await db.transaction(async (tx) => {
    const [b] = await tx
      .select()
      .from(booking)
      .where(
        and(
          eq(booking.id, input.bookingId),
          eq(booking.organizationId, input.organizationId),
          ...(input.contactId ? [eq(booking.contactId, input.contactId)] : []),
        ),
      )
      .limit(1);
    if (!b?.variantId || !activeBookingStatuses.includes(b.status))
      return { ok: false, reason: "not_found" } as const;
    const settings = await bookingSettingsOf(tx, b.organizationId, b.branchId);
    const [service] = await bookableServices(tx, {
      organizationId: b.organizationId,
      branchId: b.branchId,
      variantIds: [b.variantId],
    });
    if (!service) return { ok: false, reason: "not_bookable" } as const;
    const offered = {
      settings,
      timezone: settings.timezone,
      durationMinutes: service.durationMinutes,
      capacity: service.capacity,
      now: input.now,
    };
    if (!input.anyTime && !isOfferedTime(offered, input.startsAt))
      return { ok: false, reason: "not_offered" } as const;
    await lockService(tx, b.variantId);
    const endsAt = new Date(input.startsAt.getTime() + service.durationMinutes * 60_000);
    if (overlapsAny(input.startsAt, endsAt, blocked)) return { ok: false, reason: "busy" } as const;
    const busy = await busyFor(tx, b.variantId, input.startsAt, endsAt, b.id);
    if (!fits(input.startsAt, endsAt, busy, service.capacity, settings.bufferMinutes))
      return { ok: false, reason: "taken" } as const;
    const [row] = await tx
      .update(booking)
      .set({
        startsAt: input.startsAt,
        endsAt,
        status: "booked",
        confirmedAt: null,
        calendarSync: "pending",
        calendarAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(booking.id, b.id))
      .returning();
    if (!row) return { ok: false, reason: "not_found" } as const;
    return {
      ok: true,
      booking: row,
      label: bookingTimeLabel(row.startsAt, settings.timezone),
      meetUrl: row.meetUrl,
    } as const;
  });
  return afterChange(db, res, input.calendar);
}

/** Changes a booking's status (cancel, arrived, no-show, confirmed). */
export async function setBookingStatus(
  db: Db,
  input: {
    organizationId: string;
    bookingId: string;
    status: BookingStatus;
    contactId?: string;
    /** Only change a booking that is in one of these statuses. */
    from?: BookingStatus[];
    calendar?: CalendarDeps | null;
  },
): Promise<BookingRow | null> {
  const [row] = await db
    .update(booking)
    .set({
      status: input.status,
      ...(input.status === "cancelled" ? { cancelledAt: new Date() } : {}),
      ...(input.status === "confirmed" ? { confirmedAt: new Date() } : {}),
      ...(input.status === "cancelled" ? { calendarSync: "pending" as const, calendarAttempts: 0 } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(booking.id, input.bookingId),
        eq(booking.organizationId, input.organizationId),
        ...(input.contactId ? [eq(booking.contactId, input.contactId)] : []),
        ...(input.from ? [inArray(booking.status, input.from)] : []),
      ),
    )
    .returning();
  if (row && input.status === "cancelled" && input.calendar) await syncBooking(db, input.calendar, row.id);
  return row ?? null;
}

/** A customer's bookings from now on that still take a place. */
export async function upcomingBookingsFor(
  db: Db | Tx,
  q: { organizationId: string; contactId: string; now: Date },
): Promise<BookingRow[]> {
  return db
    .select()
    .from(booking)
    .where(
      and(
        eq(booking.organizationId, q.organizationId),
        eq(booking.contactId, q.contactId),
        inArray(booking.status, activeBookingStatuses),
        gte(booking.endsAt, q.now),
      ),
    )
    .orderBy(asc(booking.startsAt))
    .limit(20);
}

/**
 * Free times as the agent gets them: a day (or the next two weeks), optionally one part of the day,
 * at most 10, each as a local date, a 24-hour time and a label to show.
 */
export async function agentFreeTimes(
  db: Db | Tx,
  q: {
    organizationId: string;
    branchId: string;
    variantId: string;
    timezone: string;
    date?: string;
    partOfDay?: "morning" | "afternoon" | "evening";
    now: Date;
    calendar?: CalendarDeps | null;
  },
) {
  const tz = q.timezone;
  const from = q.date ? zonedTime(q.date, 0, tz) : q.now;
  const to = q.date
    ? zonedTime(nextDate(q.date), 0, tz)
    : new Date(q.now.getTime() + bookingLimits.searchDays * 86_400_000);
  const found = await findTimes(db, { ...q, from, to, limit: 300 });
  if (!found.ok) return { found: false, reason: bookingProblem[found.reason] };
  const part = (t: Date) => {
    const m = localTime(t, tz).minute;
    return m < 12 * 60 ? "morning" : m < 17 * 60 ? "afternoon" : "evening";
  };
  const times = found.times.filter((t) => !q.partOfDay || part(t) === q.partOfDay);
  if (!times.length)
    return {
      found: false,
      service: found.service.title,
      hint: q.date ? "Nothing free that day. Look at the next days (leave out date)." : "Nothing free soon.",
    };
  return {
    found: true,
    service: found.service.title,
    minutes: found.service.durationMinutes,
    times: times.slice(0, bookingLimits.agentTimes).map((t) => {
      const l = localTime(t, tz);
      const time = `${String(Math.floor(l.minute / 60)).padStart(2, "0")}:${String(l.minute % 60).padStart(2, "0")}`;
      return { date: l.date, time, label: bookingTimeLabel(t, tz) };
    }),
    more: times.length > bookingLimits.agentTimes,
  };
}
