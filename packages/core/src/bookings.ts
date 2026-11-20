import { z } from "zod";

/*
 * Booking: a branch's booking settings and the maths for free times. Shared by the API, the worker,
 * the agent and the web app, so it holds no Node-only code.
 *
 * "The place only": a bookable service (a catalogue variant with a length) can be booked by up to
 * `capacity` people at the same time (4 tables, 2 chairs). Times are worked out in the branch's
 * timezone. Days are 1 = Monday … 7 = Sunday, like broadcasts.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 09:00");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const bookingRangeSchema = z
  .object({ day: z.number().int().min(1).max(7), from: hhmm, to: hhmm })
  .refine((r) => r.to > r.from || r.to === "00:00", "The end must be after the start");
export type BookingRange = z.infer<typeof bookingRangeSchema>;

export const bookingReminderSchema = z.object({
  hoursBefore: z.number().min(0.5).max(168),
  enabled: z.boolean(),
});
export type BookingReminder = z.infer<typeof bookingReminderSchema>;

export const bookingSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Opening hours: any number of ranges per day. */
  hours: z.array(bookingRangeSchema).max(50),
  /** Whole days closed (holidays), in the branch's timezone. */
  closedDates: z.array(isoDate).max(200),
  /** Bookings start every this many minutes. */
  stepMinutes: z.number().int().min(5).max(240),
  /** Kept free after each booking. */
  bufferMinutes: z.number().int().min(0).max(240),
  /** How soon a customer can book. */
  minNoticeMinutes: z.number().int().min(0).max(10_080),
  /** How far ahead a customer can book. */
  maxDaysAhead: z.number().int().min(1).max(365),
  reminders: z.array(bookingReminderSchema).max(5),
  /** The approved "Booking reminder" template, for reminders outside the 24-hour window. */
  reminderTemplateId: z.string().nullable(),
  /** The template for online services' reminders (with the Meet link). */
  onlineReminderTemplateId: z.string().nullable().default(null),
  /** Where free times come from. Google Calendar, Calendly and Cal.com come later. */
  source: z.enum(["relay"]),
});
export type BookingSettings = z.infer<typeof bookingSettingsSchema>;

const weekdays = [1, 2, 3, 4, 5, 6];
export const defaultBookingSettings: BookingSettings = {
  enabled: false,
  hours: weekdays.map((day) => ({ day, from: "09:00", to: "18:00" })),
  closedDates: [],
  stepMinutes: 30,
  bufferMinutes: 0,
  minNoticeMinutes: 60,
  maxDaysAhead: 30,
  reminders: [
    { hoursBefore: 24, enabled: true },
    { hoursBefore: 2, enabled: true },
  ],
  reminderTemplateId: null,
  onlineReminderTemplateId: null,
  source: "relay",
};

export const bookingStatuses = ["booked", "confirmed", "arrived", "no_show", "cancelled"] as const;
export type BookingStatus = (typeof bookingStatuses)[number];
/** Statuses that take a place. */
export const activeBookingStatuses: BookingStatus[] = ["booked", "confirmed", "arrived"];

export const bookingLimits = {
  /** Free times returned to the agent at once (a WhatsApp list shows 10). */
  agentTimes: 10,
  /** Days looked at when asked for "the next free times". */
  searchDays: 14,
} as const;

/** Reply ids on a reminder's buttons. */
export const bookingReplyId = (bookingId: string, answer: "confirm" | "change") =>
  `bk_${bookingId}_${answer}`;
export function bookingReplyOf(replyId: string): { bookingId: string; answer: "confirm" | "change" } | null {
  const m = /^bk_(.+)_(confirm|change)$/.exec(replyId);
  return m ? { bookingId: m[1] as string, answer: m[2] as "confirm" | "change" } : null;
}

// ------------------------------------------------------------------ time in a timezone

type LocalNow = { date: string; weekday: number; minute: number };

/** The local date (YYYY-MM-DD), weekday (1 = Monday) and minute of the day of an instant. */
export function localTime(at: Date, timezone: string): LocalNow {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday ?? "") + 1,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** The instant a local date and minute of the day fall on in a timezone (DST-safe). */
export function zonedTime(date: string, minute: number, timezone: string): Date {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, 0, minute);
  let guess = wanted;
  // The offset at the guess, applied twice so a guess on the other side of a DST change settles.
  for (let i = 0; i < 2; i++) {
    const l = localTime(new Date(guess), timezone);
    const [ly = 0, lm = 1, ld = 1] = l.date.split("-").map(Number);
    const seen = Date.UTC(ly, lm - 1, ld, 0, l.minute);
    guess += wanted - seen;
  }
  return new Date(guess);
}

/** The next local date. */
export function nextDate(date: string): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const toMinutes = (t: string) => {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return h * 60 + m;
};

/** "Fri 21 Nov, 5:00 pm" in the branch's timezone. */
export function bookingTimeLabel(at: Date, timezone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(at)
    .toLowerCase();
  return `${day}, ${time}`;
}

const clock = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" })
    .format(at)
    .toLowerCase();

/** "5:30 – 6:00 pm" (or "11:30 am – 12:00 pm") in a timezone. */
export function bookingRangeLabel(start: Date, end: Date, timezone: string): string {
  const a = clock(start, timezone);
  const b = clock(end, timezone);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

/*
 * Where a customer is, from their WhatsApp number, so booking times can be shown in their own time.
 * Only countries with a single timezone; a number from anywhere else (the US, Australia, Russia,
 * Brazil…) gets the branch's time, as before.
 */
const phoneZones: [prefix: string, place: string, timezone: string][] = [
  ["971", "UAE", "Asia/Dubai"],
  ["973", "Bahrain", "Asia/Bahrain"],
  ["966", "Saudi", "Asia/Riyadh"],
  ["974", "Qatar", "Asia/Qatar"],
  ["965", "Kuwait", "Asia/Kuwait"],
  ["968", "Oman", "Asia/Muscat"],
  ["962", "Jordan", "Asia/Amman"],
  ["961", "Lebanon", "Asia/Beirut"],
  ["964", "Iraq", "Asia/Baghdad"],
  ["963", "Syria", "Asia/Damascus"],
  ["967", "Yemen", "Asia/Aden"],
  ["972", "Israel", "Asia/Jerusalem"],
  ["970", "Palestine", "Asia/Gaza"],
  ["91", "India", "Asia/Kolkata"],
  ["92", "Pakistan", "Asia/Karachi"],
  ["880", "Bangladesh", "Asia/Dhaka"],
  ["94", "Sri Lanka", "Asia/Colombo"],
  ["977", "Nepal", "Asia/Kathmandu"],
  ["960", "Maldives", "Indian/Maldives"],
  ["98", "Iran", "Asia/Tehran"],
  ["93", "Afghanistan", "Asia/Kabul"],
  ["90", "Turkey", "Europe/Istanbul"],
  ["20", "Egypt", "Africa/Cairo"],
  ["212", "Morocco", "Africa/Casablanca"],
  ["216", "Tunisia", "Africa/Tunis"],
  ["213", "Algeria", "Africa/Algiers"],
  ["249", "Sudan", "Africa/Khartoum"],
  ["234", "Nigeria", "Africa/Lagos"],
  ["254", "Kenya", "Africa/Nairobi"],
  ["255", "Tanzania", "Africa/Dar_es_Salaam"],
  ["256", "Uganda", "Africa/Kampala"],
  ["251", "Ethiopia", "Africa/Addis_Ababa"],
  ["233", "Ghana", "Africa/Accra"],
  ["27", "South Africa", "Africa/Johannesburg"],
  ["44", "UK", "Europe/London"],
  ["353", "Ireland", "Europe/Dublin"],
  ["33", "France", "Europe/Paris"],
  ["49", "Germany", "Europe/Berlin"],
  ["39", "Italy", "Europe/Rome"],
  ["34", "Spain", "Europe/Madrid"],
  ["31", "Netherlands", "Europe/Amsterdam"],
  ["32", "Belgium", "Europe/Brussels"],
  ["41", "Switzerland", "Europe/Zurich"],
  ["43", "Austria", "Europe/Vienna"],
  ["46", "Sweden", "Europe/Stockholm"],
  ["47", "Norway", "Europe/Oslo"],
  ["45", "Denmark", "Europe/Copenhagen"],
  ["48", "Poland", "Europe/Warsaw"],
  ["30", "Greece", "Europe/Athens"],
  ["65", "Singapore", "Asia/Singapore"],
  ["60", "Malaysia", "Asia/Kuala_Lumpur"],
  ["63", "Philippines", "Asia/Manila"],
  ["66", "Thailand", "Asia/Bangkok"],
  ["84", "Vietnam", "Asia/Ho_Chi_Minh"],
  ["86", "China", "Asia/Shanghai"],
  ["852", "Hong Kong", "Asia/Hong_Kong"],
  ["81", "Japan", "Asia/Tokyo"],
  ["82", "Korea", "Asia/Seoul"],
  ["64", "New Zealand", "Pacific/Auckland"],
];

/** The customer's place and timezone from a phone number (digits, "+" optional), or null. */
export function phoneTimezone(phone: string | null | undefined): { place: string; timezone: string } | null {
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^00/, "");
  if (digits.length < 8) return null;
  const hit = phoneZones
    .filter(([prefix]) => digits.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? { place: hit[1], timezone: hit[2] } : null;
}

/** A short name for a timezone, for "… UAE time": the country when known, else the city. */
export function timezonePlace(timezone: string): string {
  return (
    phoneZones.find(([, , tz]) => tz === timezone)?.[1] ??
    (timezone.split("/").at(-1) ?? timezone).replace(/_/g, " ")
  );
}

// ------------------------------------------------------------------ free times

export type Busy = { start: Date; end: Date };

export type FreeTimesInput = {
  settings: Pick<
    BookingSettings,
    "hours" | "closedDates" | "stepMinutes" | "bufferMinutes" | "minNoticeMinutes" | "maxDaysAhead"
  >;
  timezone: string;
  durationMinutes: number;
  /** How many can be booked at the same time. */
  capacity: number;
  /** Bookings that take a place (of this service). */
  busy: Busy[];
  /** Times closed whatever the capacity (busy in the business's Google Calendar). */
  blocked?: Busy[];
  /** Only starts in [from, to). */
  from: Date;
  to: Date;
  now: Date;
  /** Stop after this many. */
  limit?: number;
};

/** Whether `count` more bookings fit at [start, end) next to `busy`, keeping the buffer. */
export function fits(start: Date, end: Date, busy: Busy[], capacity: number, bufferMinutes: number): boolean {
  const pad = bufferMinutes * 60_000;
  const overlapping = busy.filter(
    (b) => b.start.getTime() < end.getTime() + pad && b.end.getTime() + pad > start.getTime(),
  ).length;
  return overlapping < capacity;
}

/** Whether [start, end) touches any of the intervals. */
export function overlapsAny(start: Date, end: Date, intervals: Busy[] = []): boolean {
  return intervals.some((b) => b.start.getTime() < end.getTime() && b.end.getTime() > start.getTime());
}

/** Free start times, earliest first, inside opening hours and the notice / days-ahead limits. */
export function freeTimes(input: FreeTimesInput): Date[] {
  const { settings: s, timezone, durationMinutes, capacity, busy, now } = input;
  const limit = input.limit ?? 200;
  if (durationMinutes <= 0 || capacity <= 0) return [];
  const earliest = Math.max(input.from.getTime(), now.getTime() + s.minNoticeMinutes * 60_000);
  const latest = Math.min(input.to.getTime(), now.getTime() + s.maxDaysAhead * 86_400_000);
  if (earliest >= latest) return [];
  const out: Date[] = [];
  const closed = new Set(s.closedDates);
  let date = localTime(new Date(earliest), timezone).date;
  for (let days = 0; days < 400; days++, date = nextDate(date)) {
    const dayStart = zonedTime(date, 0, timezone).getTime();
    if (dayStart > latest) break;
    if (closed.has(date)) continue;
    const weekday = localTime(new Date(dayStart + 12 * 3_600_000), timezone).weekday;
    const ranges = s.hours
      .filter((r) => r.day === weekday)
      .sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
    for (const r of ranges) {
      const close = toMinutes(r.to) || 24 * 60;
      for (let m = toMinutes(r.from); m + durationMinutes <= close; m += s.stepMinutes) {
        const start = zonedTime(date, m, timezone);
        const t = start.getTime();
        if (t < earliest || t >= latest) continue;
        const end = new Date(t + durationMinutes * 60_000);
        if (overlapsAny(start, end, input.blocked)) continue;
        if (!fits(start, end, busy, capacity, s.bufferMinutes)) continue;
        if (!out.some((x) => x.getTime() === t)) out.push(start);
        if (out.length >= limit) return out;
      }
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Whether a start is one the business offers (in hours, on the step, within the limits). */
export function isOfferedTime(
  input: Omit<FreeTimesInput, "from" | "to" | "limit" | "busy">,
  start: Date,
): boolean {
  const day = localTime(start, input.timezone).date;
  const from = zonedTime(day, 0, input.timezone);
  return freeTimes({ ...input, busy: [], from, to: new Date(from.getTime() + 86_400_000 + 3_600_000) }).some(
    (t) => t.getTime() === start.getTime(),
  );
}
