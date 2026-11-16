import {
  type AskLocationConfig,
  type AskQuestionConfig,
  type ConditionRule,
  type InboundEventPayload,
  type LocationAnswer,
  locationAnswer,
} from "@relay/core/automations";

/*
 * Pure helpers for the automation runtime: reading an answer, business hours, and the next time of day
 * in a timezone. Kept apart from the database code so they can be tested on their own.
 */

/** The option id or text an answer stands for, or null when it doesn't fit the question. */
export function readAnswer(
  q: AskQuestionConfig,
  event: Pick<InboundEventPayload, "type" | "text" | "reply">,
  optionOf: (replyId: string) => string | null,
): { handle: string; value: string } | null {
  if (q.answer.type === "buttons") {
    const options = q.answer.options;
    if (event.reply) {
      const id = optionOf(event.reply.id);
      const opt = id ? options.find((o) => o.id === id) : undefined;
      if (opt) return { handle: `opt:${opt.id}`, value: opt.title };
      return null; // a button from another (older) question
    }
    // Typed instead of tapped: the option's title, or its number.
    const typed = event.text.trim().toLowerCase();
    if (!typed) return null;
    const byTitle = options.find((o) => o.title.trim().toLowerCase() === typed);
    const byNumber = /^\d{1,2}$/.test(typed) ? options[Number(typed) - 1] : undefined;
    const opt = byTitle ?? byNumber;
    return opt ? { handle: `opt:${opt.id}`, value: opt.title } : null;
  }
  const text = event.text.trim();
  if (!text) return null;
  switch (q.answer.format) {
    case "number": {
      const n = Number(text.replace(/[,\s]/g, ""));
      return Number.isFinite(n) ? { handle: "next", value: String(n) } : null;
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text)
        ? { handle: "next", value: text.toLowerCase() }
        : null;
    case "phone": {
      const digits = text.replace(/[^\d]/g, "");
      return digits.length >= 8 && digits.length <= 15 ? { handle: "next", value: digits } : null;
    }
    case "date": {
      const d = parseDate(text);
      return d ? { handle: "next", value: d } : null;
    }
    default:
      return { handle: "next", value: text };
  }
}

/**
 * A shared location answers "Ask for location"; with acceptTyped, so does a typed address (at least a
 * few characters, saved without a pin). Anything else doesn't fit.
 */
export function readLocation(
  q: Pick<AskLocationConfig, "acceptTyped">,
  event: Pick<InboundEventPayload, "type" | "text" | "location">,
): { handle: string; value: LocationAnswer } | null {
  if (event.location) return { handle: "next", value: locationAnswer(event.location) };
  if (q.acceptTyped && event.type === "text" && event.text.trim().length >= 3)
    return { handle: "next", value: locationAnswer(null, event.text) };
  return null;
}

/** 2026-11-15, 15/11/2026, 15-11-2026 or 15 Nov 2026 → "2026-11-15". Day first, as customers write. */
export function parseDate(text: string): string | null {
  const t = text.trim();
  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dayFirst) [d, m, y] = [Number(dayFirst[1]), Number(dayFirst[2]), Number(dayFirst[3])];
  else {
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

/** Day of week (0 = Sunday) and minutes since midnight at `at`, in a timezone. */
export function zonedParts(at: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function withinBusinessHours(rule: Extract<ConditionRule, { kind: "business_hours" }>, at: Date) {
  const { day, minutes } = zonedParts(at, rule.timezone);
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const from = toMin(rule.from);
  const to = toMin(rule.to);
  if (!rule.days.includes(day)) return false;
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** The next moment the clock in `timeZone` shows HH:MM (today if still ahead, else tomorrow). */
export function nextTimeOfDay(time: string, timeZone: string, now = new Date()): Date {
  const target = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const { minutes } = zonedParts(now, timeZone);
  let deltaMin = target - minutes;
  if (deltaMin <= 0) deltaMin += 24 * 60;
  const at = new Date(now.getTime() + deltaMin * 60_000);
  at.setUTCSeconds(0, 0);
  return at;
}
