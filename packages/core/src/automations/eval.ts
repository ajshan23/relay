/*
 * Pure helpers shared by the worker, the utilities and the tests: reading a date the way customers write
 * it, the clock in a timezone, calendar-day arithmetic, comparing a value in a rule, and date rules.
 * Nothing here reads the clock itself: "now" is always passed in, so a run replays the same.
 */

/** 2026-11-15, 15/11/2026, 15-11-2026 or 15 Nov 2026 → "2026-11-15". Day first, as customers write. */
export function parseDate(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dayFirst) [d, m, y] = [Number(dayFirst[1]), Number(dayFirst[2]), Number(dayFirst[3])];
  else {
    // Written out ("15 Nov 2026", "Nov 15, 2026"): needs a month name and a day, not just any number.
    if (!/[a-z]{3}/i.test(t) || !/\d/.test(t)) return null;
    const parsed = Date.parse(t);
    if (Number.isNaN(parsed)) return null;
    const dt = new Date(parsed);
    [y, m, d] = [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()];
  }
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A date out of a saved value, as a calendar day in `timeZone`: a full timestamp (contact "Added on")
 * is the day it was there; anything else is read like a typed date.
 */
export function readDate(value: unknown, timeZone: string): string | null {
  // A worked-out date ({{values.next_visit}}) carries its day; other results read as their text.
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const v = value as { date?: unknown; text?: unknown };
    return readDate(typeof v.date === "string" ? v.date : v.text, timeZone);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : zonedDate(value, timeZone);
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    const at = new Date(s);
    if (!Number.isNaN(at.getTime())) return zonedDate(at, timeZone);
  }
  return parseDate(s);
}

/** The wall clock in a timezone at `at`. */
export type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

export function wallClock(at: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

/** Day of week (0 = Sunday) and minutes since midnight at `at`, in a timezone. */
export function zonedParts(at: Date, timeZone: string): { day: number; minutes: number } {
  const w = wallClock(at, timeZone);
  return { day: w.weekday, minutes: w.hour * 60 + w.minute };
}

/** "YYYY-MM-DD" of `at` in a timezone. */
export function zonedDate(at: Date, timeZone: string): string {
  const w = wallClock(at, timeZone);
  return isoDay(w.year, w.month, w.day);
}

export const isoDay = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Whole calendar days from a to b ("2026-11-15" → "2026-11-17" is 2). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Calendar date plus whole days. */
export function addDays(date: string, days: number): string {
  const d = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return isoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = Sunday … 6 = Saturday, for a calendar date. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/* ------------------------------------------------------------------ value rules */

export const valueOps = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "starts_with",
  "is_one_of",
  "is_empty",
  "is_not_empty",
  "gt",
  "lt",
] as const;
export type ValueOp = (typeof valueOps)[number];

/** A number as customers and fields write it: "1,200", "₹ 1200", "AED 75.5". */
export function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const s = value
    .trim()
    .replace(/^[^\d+\-.]+/, "")
    .replace(/[\s,]/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Compares a value in a rule. Case and outer spaces don't matter. */
export function compare(value: string, op: string, expected: string): boolean {
  const v = value.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  switch (op) {
    case "is":
      return v === e;
    case "is_not":
      return v !== e;
    case "contains":
      return !!e && v.includes(e);
    case "not_contains":
      return !e || !v.includes(e);
    case "starts_with":
      return !!e && v.startsWith(e);
    case "is_one_of":
      return e
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .includes(v);
    case "is_empty":
      return !v;
    case "is_not_empty":
      return !!v;
    case "gt":
    case "lt": {
      const a = readNumber(v);
      const b = readNumber(e);
      if (a === null || b === null) return false;
      return op === "gt" ? a > b : a < b;
    }
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ date rules */

export const dateOps = [
  "is_today",
  "is_tomorrow",
  "is_past",
  "is_future",
  "in_next_days",
  "in_last_days",
  "more_than_days_away",
  "more_than_days_ago",
  "before",
  "on",
  "after",
  "between",
  "weekday_in",
  "not_a_date",
] as const;
export type DateOp = (typeof dateOps)[number];

/** Ops that make sense when the rule is about today itself (holidays, special days). */
export const todayOps: readonly DateOp[] = ["on", "between", "before", "after", "weekday_in"];
/** Ops that need a number of days, a date, two dates, or weekdays. */
export const dateOpNeeds: Record<DateOp, "days" | "date" | "range" | "weekdays" | null> = {
  is_today: null,
  is_tomorrow: null,
  is_past: null,
  is_future: null,
  in_next_days: "days",
  in_last_days: "days",
  more_than_days_away: "days",
  more_than_days_ago: "days",
  before: "date",
  on: "date",
  after: "date",
  between: "range",
  weekday_in: "weekdays",
  not_a_date: null,
};

export type DateRuleShape = {
  op: string;
  days?: number;
  date?: string;
  to?: string;
  weekdays?: number[];
};

/**
 * Whether a date (a calendar day, or null when the value isn't a date) passes a rule, with `today`
 * being today in the rule's timezone. "Within the next 3 days" counts today and the next 3.
 */
export function dateMatches(date: string | null, rule: DateRuleShape, today: string): boolean {
  if (rule.op === "not_a_date") return date === null;
  if (date === null) return false;
  const diff = daysBetween(today, date); // > 0: in the future
  const n = rule.days ?? 0;
  switch (rule.op) {
    case "is_today":
      return diff === 0;
    case "is_tomorrow":
      return diff === 1;
    case "is_past":
      return diff < 0;
    case "is_future":
      return diff > 0;
    case "in_next_days":
      return diff >= 0 && diff <= n;
    case "in_last_days":
      return diff <= 0 && -diff <= n;
    case "more_than_days_away":
      return diff > n;
    case "more_than_days_ago":
      return -diff > n;
    case "before":
      return !!rule.date && date < rule.date;
    case "on":
      return !!rule.date && date === rule.date;
    case "after":
      return !!rule.date && date > rule.date;
    case "between": {
      if (!rule.date || !rule.to) return false;
      const [from, to] = rule.date <= rule.to ? [rule.date, rule.to] : [rule.to, rule.date];
      return date >= from && date <= to;
    }
    case "weekday_in":
      return (rule.weekdays ?? []).includes(weekdayOf(date));
    default:
      return false;
  }
}
