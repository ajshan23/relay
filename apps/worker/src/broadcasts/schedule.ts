import type { BroadcastSchedule } from "@relay/db/schema";

/*
 * Sending hours and daily pacing for broadcasts, in the broadcast's own time zone. Pure functions, so
 * they're easy to test with any clock.
 */

const MINUTES_PER_DAY = 24 * 60;

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
export function windowState(schedule: BroadcastSchedule, now: Date) {
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
      opensAt: null,
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
      opensAt: new Date(now.getTime() + (minutesAhead * 60 - p.second) * 1000),
    };
  }
  return { open: false, fraction: 0, opensAt: null };
}

/** How many sending days are left from now until a date (at least 1). */
export function sendingDaysUntil(schedule: BroadcastSchedule, now: Date, end: Date) {
  const days = schedule.window?.days ?? [1, 2, 3, 4, 5, 6, 7];
  let count = 0;
  for (let t = now.getTime(); t <= end.getTime() && count < 400; t += 86_400_000) {
    if (days.includes(localParts(new Date(t), schedule.timezone).weekday)) count++;
  }
  return Math.max(1, count);
}
