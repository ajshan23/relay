import { fillVariables, type TemplateContent, templateVariables } from "./templates";

/*
 * Sending hours, daily pacing and the day-by-day plan for broadcasts, in the broadcast's own time
 * zone. Pure functions shared by the API (estimates) and the worker (sending), so both agree.
 */

export type ScheduleLike = {
  startAt?: string | null;
  timezone: string;
  window: { days: number[]; from: string; to: string } | null;
  perDay?: number | null;
  endBy?: string | null;
  retry?: { enabled: boolean; attempts: number };
};

const MINUTES_PER_DAY = 24 * 60;
const DAY_MS = 86_400_000;
/** Default share of the daily limit a broadcast uses when no per-day number is set. */
export const DEFAULT_SHARE = 0.75;
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** The local weekday (1 = Monday … 7 = Sunday), minute of the day and date in a time zone. */
export function localParts(now: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "") + 1;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return {
    weekday,
    minute,
    second: Number(parts.second),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** When the local day started (UTC instant), for counting today's sends. */
export function startOfLocalDay(now: Date, timezone: string) {
  const p = localParts(now, timezone);
  return new Date(now.getTime() - (p.minute * 60 + p.second) * 1000 - now.getMilliseconds());
}

/**
 * Whether sending is allowed now, how far through today's window we are (0–1, for even pacing), and
 * when it next opens.
 */
export function windowState(schedule: ScheduleLike, now: Date) {
  const w = schedule.window;
  if (!w) {
    const p = localParts(now, schedule.timezone);
    return { open: true, fraction: (p.minute + 1) / MINUTES_PER_DAY, opensAt: null as Date | null };
  }
  const from = toMinutes(w.from);
  const to = toMinutes(w.to) || MINUTES_PER_DAY;
  const p = localParts(now, schedule.timezone);
  const today = w.days.includes(p.weekday);
  if (today && p.minute >= from && p.minute < to)
    return {
      open: true,
      fraction: Math.min(1, (p.minute - from + 1) / Math.max(1, to - from)),
      opensAt: null as Date | null,
    };
  // Next opening: today later, or the next allowed day.
  for (let add = 0; add <= 7; add++) {
    const day = ((p.weekday - 1 + add) % 7) + 1;
    if (!w.days.includes(day)) continue;
    if (add === 0 && p.minute >= from) continue;
    const minutesAhead = add * MINUTES_PER_DAY + from - p.minute;
    return {
      open: false,
      fraction: 0,
      opensAt: new Date(now.getTime() + (minutesAhead * 60 - p.second) * 1000) as Date | null,
    };
  }
  return { open: false, fraction: 0, opensAt: null as Date | null };
}

/** The first moment at or after `at` inside the sending hours. */
export function nextSendTime(schedule: ScheduleLike, at: Date) {
  const w = windowState(schedule, at);
  return w.open ? at : (w.opensAt ?? at);
}

/** How many sending days are left from now until a date (at least 1). */
export function sendingDaysUntil(schedule: ScheduleLike, now: Date, end: Date) {
  const days = schedule.window?.days ?? ALL_DAYS;
  let count = 0;
  for (let t = now.getTime(); t <= end.getTime() && count < 400; t += DAY_MS) {
    if (days.includes(localParts(new Date(t), schedule.timezone).weekday)) count++;
  }
  return Math.max(1, count);
}

/** The retry setting, with old broadcasts (no setting) treated as "on, once". */
export function retryOf(schedule: ScheduleLike) {
  const r = schedule.retry ?? { enabled: true, attempts: 1 };
  return { enabled: r.enabled, attempts: Math.min(3, Math.max(1, Math.round(r.attempts || 1))) };
}

/** Messages per day: fixed, spread to finish by a date, or a share of the daily limit (-1 = none). */
export function perDayFor(schedule: ScheduleLike, left: number, dailyLimit: number, now: Date) {
  if (schedule.perDay) return schedule.perDay;
  if (schedule.endBy)
    return Math.max(1, Math.ceil(left / sendingDaysUntil(schedule, now, new Date(schedule.endBy))));
  return dailyLimit === -1 ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(dailyLimit * DEFAULT_SHARE));
}

export type PlanDay = { date: string; weekday: number; from: string; to: string; count: number };

/**
 * The day-by-day plan: how many go out on each sending day, from the start until everyone is
 * reached. Today counts only if its sending hours haven't ended.
 */
export function planDays(schedule: ScheduleLike, reach: number, dailyLimit: number, now = new Date()) {
  const start = schedule.startAt ? new Date(Math.max(now.getTime(), Date.parse(schedule.startAt))) : now;
  const perDay = perDayFor(schedule, reach, dailyLimit, start);
  const days = schedule.window?.days ?? ALL_DAYS;
  const from = schedule.window?.from ?? "00:00";
  const to = schedule.window?.to ?? "24:00";
  const endMinute = toMinutes(to) || MINUTES_PER_DAY;
  const out: PlanDay[] = [];
  let left = reach;
  for (let i = 0; left > 0 && i < 800; i++) {
    const p = localParts(new Date(start.getTime() + i * DAY_MS), schedule.timezone);
    if (!days.includes(p.weekday)) continue;
    if (i === 0 && p.minute >= endMinute) continue;
    const count = Math.min(left, Number.isFinite(perDay) ? perDay : left);
    out.push({ date: p.date, weekday: p.weekday, from, to, count });
    left -= count;
  }
  const retry = retryOf(schedule);
  return {
    perDay: Number.isFinite(perDay) ? perDay : null,
    days: out,
    retryDays: retry.enabled ? retry.attempts : 0,
  };
}

/* ------------------------------------------------------------------ message content */

export type ValueSpec =
  | { source: "static"; text: string }
  | { source: "field"; key: string; fallback?: string };

type ContactLike = {
  name: string | null;
  phone: string | null;
  email: string | null;
  attributes: unknown;
};

/** The value of each template detail for one contact; null when a required one is missing. */
export function valuesFor(specs: Record<string, ValueSpec>, tc: TemplateContent, contact: ContactLike) {
  const out: Record<string, string> = {};
  for (const name of templateVariables(tc)) {
    const spec = specs[name];
    let v: string | null | undefined = null;
    if (spec?.source === "static") v = spec.text;
    else if (spec?.source === "field") {
      const key = spec.key;
      if (key === "name") v = contact.name;
      else if (key === "first_name") v = contact.name?.trim().split(/\s+/)[0] ?? null;
      else if (key === "phone") v = contact.phone;
      else if (key === "email") v = contact.email;
      else {
        const raw = ((contact.attributes ?? {}) as Record<string, unknown>)[key];
        v = raw === undefined || raw === null ? null : Array.isArray(raw) ? raw.join(", ") : String(raw);
      }
      if (!v?.toString().trim()) v = spec.fallback ?? null;
    }
    if (!v?.toString().trim()) return null;
    out[name] = String(v).trim().slice(0, 1000);
  }
  return out;
}

/** A template message's stored content, with the details filled in. */
export function templateMessage(
  template: { id: string; name: string; slug: string; language: string },
  tc: TemplateContent,
  values: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "template",
    templateId: template.id,
    templateName: template.name,
    name: template.slug,
    language: template.language,
    values,
    header:
      tc.header?.kind === "text"
        ? { kind: "text", text: fillVariables(tc.header.text, values) }
        : (tc.header ?? null),
    body: fillVariables(tc.body, values),
    footer: tc.footer,
    buttons: tc.buttons,
    auth: !!tc.auth,
    ...extra,
  };
}
