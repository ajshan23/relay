import { z } from "zod";
import { daysBetween, isoDay, readDate, readNumber, type Wall, wallClock, zonedDate } from "./eval";

/*
 * Utilities: steps that work something out and save it under a name, {{values.<name>}}, for later
 * messages and rules. They never message anyone. Each function is one entry in `utilityFunctions`:
 * its fields, the parts its result has ({{values.dist.km}}), and a pure compute(). Adding a function
 * is adding an entry here and a small form in the editor; the step type, validation, history and the
 * engine pick it up from the registry.
 *
 * A result is `{ text, ...parts }`: {{values.dist}} reads the text ("4.2 km"), parts are numbers or
 * text. compute() never reads the clock or randomness itself; the engine passes them in and records
 * the result, so a replayed run gets the same answer.
 */

export type UtilityValue = { text: string } & Record<string, string | number | null>;
export type UtilityResult =
  | { ok: true; value: UtilityValue }
  /** Takes the step's second exit; `value`, when given, is still saved (a lookup's fallback). */
  | { ok: false; reason: string; value?: UtilityValue };

export type UtilityIO = {
  /** A saved value by path ("answers.pickup"), as stored: a shared location stays an object. */
  read: (path: string) => unknown;
  /** A text with its {{variables}} filled in. */
  fill: (text: string) => string;
  now: Date;
  /** A random whole number from 0 to n - 1. */
  randomInt: (n: number) => number;
};

export type UtilityGroup = "Location" | "Date and time" | "Numbers" | "Text" | "Generators" | "Lookup";
/** A value a utility reads, and what it must be. */
export type UtilityRef = { path: string; kind: "location" | "date" | "any" };

type Def<S extends z.ZodRawShape> = {
  fn: string;
  label: string;
  description: string;
  group: UtilityGroup;
  icon: string;
  fields: S;
  /** A new step's settings for this function. */
  defaults: () => Record<string, unknown>;
  /** Parts of the result besides its text. */
  parts: readonly string[];
  /** The exit taken when it worked ("Done" when not given). */
  okLabel?: string;
  /** The second exit, for functions that can come up empty. */
  failLabel?: string;
  summary: (c: NoInfer<z.infer<z.ZodObject<S>>>) => string;
  refs: (c: NoInfer<z.infer<z.ZodObject<S>>>) => UtilityRef[];
  /** Texts that may hold {{variables}}. */
  texts: (c: NoInfer<z.infer<z.ZodObject<S>>>) => string[];
  /** A problem with the settings that the schema can't see (a formula with a mistake). */
  check?: (c: NoInfer<z.infer<z.ZodObject<S>>>) => string | null;
  compute: (c: NoInfer<z.infer<z.ZodObject<S>>>, io: UtilityIO) => UtilityResult;
};
const def = <S extends z.ZodRawShape>(d: Def<S>) => d;

/* ------------------------------------------------------------------ shared pieces */

export const savedValueName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and _ (start with a letter)");
/** "answers.pickup", "values.next_visit", "contact.birthday"… (no braces). */
const valuePath = z.string().regex(/^[a-z][\w]*(\.[\w-]+)+$/, "Pick a value");
/** A saved value, or the moment the step runs. */
const dateSource = z.union([z.literal("today"), valuePath]);
const timezone = z.string().min(1);

export const placeSchema = z
  .object({
    name: z.string().trim().max(100, "At most 100 characters").default(""),
    address: z.string().trim().max(300, "At most 300 characters").default(""),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .refine((p) => !(p.latitude === 0 && p.longitude === 0), "Choose the place on the map");
export type Place = z.infer<typeof placeSchema>;

type Pin = { latitude: number; longitude: number };
/** A pin out of a saved value (a shared location), or null (typed address, or not a location). */
function pinOf(v: unknown): Pin | null {
  if (!v || typeof v !== "object") return null;
  const { latitude, longitude } = v as { latitude?: unknown; longitude?: unknown };
  return typeof latitude === "number" && typeof longitude === "number" ? { latitude, longitude } : null;
}

/** Straight-line distance in metres (haversine). */
export function distanceMeters(a: Pin, b: Pin): number {
  const R = 6_371_008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
/** "850 m", "4.2 km", "36 km"; "0.4 mi", "12 mi". */
function distanceText(m: number, unit: "km" | "mi"): string {
  if (unit === "mi") {
    const mi = m / 1609.344;
    return `${mi < 100 ? round(mi, 1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${km < 100 ? round(km, 1) : Math.round(km)} km`;
}
const distanceParts = (m: number) => ({
  km: round(m / 1000, 1),
  miles: round(m / 1609.344, 1),
  meters: Math.round(m),
});
const mapLink = (p: Pin) => `https://www.google.com/maps?q=${p.latitude},${p.longitude}`;

const sourceLabel = (path: string) => (path === "today" ? "today" : `{{${path}}}`);

/* ------------------------------------------------------------------ dates */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** A wall-clock moment kept in a UTC Date (no timezone maths after this point). */
const toNaive = (w: Pick<Wall, "year" | "month" | "day" | "hour" | "minute">) =>
  new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute));

function addCalendar(at: Date, amount: number, unit: string): Date {
  const d = new Date(at.getTime());
  switch (unit) {
    case "minutes":
      return new Date(d.getTime() + amount * 60_000);
    case "hours":
      return new Date(d.getTime() + amount * 3_600_000);
    case "days":
      return new Date(d.getTime() + amount * 86_400_000);
    case "weeks":
      return new Date(d.getTime() + amount * 7 * 86_400_000);
    case "months":
    case "years": {
      const months = unit === "years" ? amount * 12 : amount;
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + months);
      // 31 Jan + 1 month is the last day of February, not 3 March.
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      return d;
    }
    default:
      return d;
  }
}

function partOfDay(hour: number): string {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

const clock = (h: number, m: number) =>
  `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;

/** Whole months from a to b (calendar dates), counting a month only once its day is reached. */
function wholeMonths(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  let months = (by - ay) * 12 + (bm - am);
  if (months > 0 && bd < ad) months--;
  if (months < 0 && bd > ad) months++;
  return months;
}

/* ------------------------------------------------------------------ calculate */

type Token =
  | { t: "num"; v: number }
  | { t: "var"; path: string; fallback?: string; raw: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (src.startsWith("{{", i)) {
      const end = src.indexOf("}}", i);
      if (end < 0) throw new FormulaError(`a {{ without }}`);
      const inner = src.slice(i + 2, end).trim();
      const [path, fallback] = inner.split("|");
      out.push({
        t: "var",
        path: (path ?? "").trim(),
        fallback: fallback?.trim(),
        raw: src.slice(i, end + 2),
      });
      i = end + 2;
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z]+/i.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    if ("+-*/%()×÷,".includes(ch)) {
      out.push({ t: "op", v: ch === "×" ? "*" : ch === "÷" ? "/" : ch });
      i++;
      continue;
    }
    throw new FormulaError(`“${ch}”`);
  }
  return out;
}

class FormulaError extends Error {}
class NotANumber extends Error {
  constructor(readonly what: string) {
    super(what);
  }
}

const formulaFns: Record<string, (args: number[]) => number> = {
  round: ([x = 0, d = 0]) => round(x, Math.max(0, Math.min(6, Math.trunc(d)))),
  floor: ([x = 0]) => Math.floor(x),
  ceil: ([x = 0]) => Math.ceil(x),
  abs: ([x = 0]) => Math.abs(x),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
};

/**
 * Works out a formula: + - * / % and brackets, round(x, d) floor ceil abs min max, and {{values}}.
 * No code runs: it's a small parser. `value` turns a {{variable}} into a number (or throws NotANumber).
 */
function evaluateFormula(src: string, value: (path: string, fallback?: string) => number): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => {
    const t = toks[p];
    return t?.t === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(p < toks.length ? `position ${p + 1}` : "the end");
    p++;
  };
  const expr = (): number => {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[p++] as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = (toks[p++] as { v: string }).v;
      const r = factor();
      if ((op === "/" || op === "%") && r === 0) throw new FormulaError("division by zero");
      v = op === "/" ? v / r : op === "%" ? v % r : v * r;
    }
    return v;
  };
  const factor = (): number => {
    const t = peek();
    if (!t) throw new FormulaError("the end");
    if (t.t === "op" && (t.v === "-" || t.v === "+")) {
      p++;
      const v = factor();
      return t.v === "-" ? -v : v;
    }
    if (t.t === "num") {
      p++;
      return t.v;
    }
    if (t.t === "var") {
      p++;
      return value(t.path, t.fallback);
    }
    if (t.t === "id") {
      const fn = formulaFns[t.v];
      if (!fn) throw new FormulaError(`“${t.v}”`);
      p++;
      expect("(");
      const args = [expr()];
      while (isOp(",")) {
        p++;
        args.push(expr());
      }
      expect(")");
      return fn(args);
    }
    if (t.t === "op" && t.v === "(") {
      p++;
      const v = expr();
      expect(")");
      return v;
    }
    throw new FormulaError(`“${t.v}”`);
  };
  const result = expr();
  if (p < toks.length) throw new FormulaError(`position ${p + 1}`);
  if (!Number.isFinite(result)) throw new FormulaError("a result too big to use");
  return result;
}

/** A mistake in a formula, in words, or null when it reads fine. */
export function formulaProblem(src: string): string | null {
  if (!src.trim()) return "Write the formula";
  try {
    evaluateFormula(src, () => 1);
    return null;
  } catch (err) {
    if (err instanceof FormulaError)
      return err.message === "division by zero" ? null : `The formula has a mistake near ${err.message}.`;
    return "The formula has a mistake.";
  }
}

export const currencies = ["INR", "AED", "SAR", "QAR", "OMR", "KWD", "BHD", "USD", "EUR", "GBP"] as const;

function formatNumber(n: number, decimals: number, currency: string): string {
  const whole = Number.isInteger(n);
  const locale = currency === "INR" ? "en-IN" : "en-US";
  return new Intl.NumberFormat(locale, {
    ...(currency ? { style: "currency", currency, currencyDisplay: "symbol" } : {}),
    minimumFractionDigits: whole ? 0 : Math.min(decimals, 2),
    maximumFractionDigits: decimals,
  }).format(n);
}

/* ------------------------------------------------------------------ text */

const finders = {
  number: /[-+]?\d[\d,]*(?:\.\d+)?/g,
  email: /[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}/gi,
  phone: /\+?\d[\d\s-]{6,17}\d/g,
  pincode: /\b\d{6}\b/g,
  link: /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi,
} as const;

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'(])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

function changeText(c: { mode: string; maxLength: number }, text: string): UtilityResult {
  const t = text.trim().replace(/\s+/g, " ");
  const out =
    c.mode === "title"
      ? titleCase(t)
      : c.mode === "upper"
        ? t.toUpperCase()
        : c.mode === "lower"
          ? t.toLowerCase()
          : c.mode === "first_word"
            ? (t.split(" ")[0] ?? "")
            : [...t].length > c.maxLength
              ? `${[...t].slice(0, Math.max(1, c.maxLength - 1)).join("")}…`
              : t;
  return { ok: true, value: { text: out } };
}

function findInText(c: { find: keyof typeof finders }, text: string): UtilityResult {
  let found = [...text.matchAll(finders[c.find])].map((m) => m[0].trim());
  if (c.find === "number") found = found.map((n) => n.replace(/,/g, ""));
  if (c.find === "phone")
    found = found
      .map((n) => (n.startsWith("+") ? "+" : "") + n.replace(/\D/g, ""))
      .filter((n) => n.replace("+", "").length >= 8 && n.replace("+", "").length <= 15);
  if (c.find === "email") found = found.map((e) => e.toLowerCase());
  if (!found.length) return { ok: false, reason: "not_found" };
  return { ok: true, value: { text: found[0] as string, all: found.join(", "), count: found.length } };
}

const REF_DIGITS = "23456789";
const REF_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";

/* ------------------------------------------------------------------ the functions */

export const utilityFunctions = {
  distance: def({
    fn: "distance",
    label: "Distance between places",
    description: "How far a shared location is from a place, as the crow flies.",
    group: "Location",
    icon: "route",
    fields: {
      from: valuePath,
      to: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("place"), place: placeSchema }),
        z.object({ kind: z.literal("answer"), path: valuePath }),
      ]),
      unit: z.enum(["km", "mi"]).default("km"),
    },
    defaults: () => ({
      from: "",
      to: { kind: "place", place: { name: "", address: "", latitude: 0, longitude: 0 } },
      unit: "km",
    }),
    parts: ["km", "miles", "meters"],
    failLabel: "No pin shared",
    summary: (c) =>
      c.from
        ? `{{${c.from}}} to ${c.to.kind === "place" ? c.to.place.name || "a place" : `{{${c.to.path}}}`}`
        : "Pick the location",
    refs: (c) => [
      { path: c.from, kind: "location" },
      ...(c.to.kind === "answer" ? [{ path: c.to.path, kind: "location" as const }] : []),
    ],
    texts: () => [],
    compute: (c, io) => {
      const a = pinOf(io.read(c.from));
      const b = c.to.kind === "place" ? c.to.place : pinOf(io.read(c.to.path));
      if (!a || !b) return { ok: false, reason: "no_pin" };
      const m = distanceMeters(a, b);
      return { ok: true, value: { text: distanceText(m, c.unit), ...distanceParts(m) } };
    },
  }),

  nearest: def({
    fn: "nearest",
    label: "Nearest of your places",
    description: "Which of your places is closest to a shared location.",
    group: "Location",
    icon: "location",
    fields: {
      from: valuePath,
      places: z
        .array(
          z
            .object({
              name: z.string().trim().min(1, "Name every place").max(100),
              address: z.string().trim().max(300).default(""),
              latitude: z.number().min(-90).max(90),
              longitude: z.number().min(-180).max(180),
            })
            .refine((p) => !(p.latitude === 0 && p.longitude === 0), "Choose every place on the map"),
        )
        .min(2, "Add at least two places")
        .max(20, "At most 20 places"),
      unit: z.enum(["km", "mi"]).default("km"),
    },
    defaults: () => ({ from: "", places: [], unit: "km" }),
    parts: ["name", "address", "map_link", "distance", "km"],
    failLabel: "No pin shared",
    summary: (c) => (c.places.length ? `Closest of ${c.places.length} places` : "Add your places"),
    refs: (c) => [{ path: c.from, kind: "location" }],
    texts: () => [],
    compute: (c, io) => {
      const a = pinOf(io.read(c.from));
      if (!a || !c.places.length) return { ok: false, reason: "no_pin" };
      let best = c.places[0] as (typeof c.places)[number];
      let bestM = Number.POSITIVE_INFINITY;
      for (const p of c.places) {
        const m = distanceMeters(a, p);
        if (m < bestM) [best, bestM] = [p, m];
      }
      return {
        ok: true,
        value: {
          text: best.name,
          name: best.name,
          address: best.address,
          map_link: mapLink(best),
          distance: distanceText(bestM, c.unit),
          km: round(bestM / 1000, 1),
        },
      };
    },
  }),

  date_time: def({
    fn: "date_time",
    label: "Date and time",
    description: "Today or a saved date, moved forward or back, in words.",
    group: "Date and time",
    icon: "calendar",
    fields: {
      start: dateSource.default("today"),
      change: z.enum(["none", "add", "subtract"]).default("none"),
      amount: z.number().int().min(0).max(10_000).default(1),
      unit: z.enum(["minutes", "hours", "days", "weeks", "months", "years"]).default("days"),
      show: z.enum(["date", "date_time", "time"]).default("date"),
      timezone,
    },
    defaults: () => ({
      start: "today",
      change: "none",
      amount: 1,
      unit: "days",
      show: "date",
      timezone: "Asia/Kolkata",
    }),
    parts: ["date", "time", "weekday", "day", "month", "year", "hour", "part_of_day"],
    failLabel: "Not a date",
    summary: (c) =>
      `${c.start === "today" ? "Now" : `{{${c.start}}}`}${
        c.change === "none" ? "" : ` ${c.change === "add" ? "+" : "−"} ${c.amount} ${c.unit}`
      }`,
    refs: (c) => (c.start === "today" ? [] : [{ path: c.start, kind: "date" }]),
    texts: () => [],
    compute: (c, io) => {
      let at: Date;
      if (c.start === "today") at = toNaive(wallClock(io.now, c.timezone));
      else {
        const d = readDate(io.read(c.start), c.timezone);
        if (!d) return { ok: false, reason: "not_a_date" };
        const [year, month, day] = d.split("-").map(Number) as [number, number, number];
        at = toNaive({ year, month, day, hour: 0, minute: 0 });
      }
      if (c.change !== "none") at = addCalendar(at, c.change === "add" ? c.amount : -c.amount, c.unit);
      const y = at.getUTCFullYear();
      const mo = at.getUTCMonth();
      const d = at.getUTCDate();
      const h = at.getUTCHours();
      const mi = at.getUTCMinutes();
      const wd = at.getUTCDay();
      const dateText = `${WEEKDAYS[wd]?.slice(0, 3)}, ${d} ${MONTHS[mo]?.slice(0, 3)} ${y}`;
      const timeText = clock(h, mi);
      return {
        ok: true,
        value: {
          text: c.show === "time" ? timeText : c.show === "date_time" ? `${dateText}, ${timeText}` : dateText,
          date: isoDay(y, mo + 1, d),
          time: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`,
          weekday: WEEKDAYS[wd] ?? "",
          day: d,
          month: MONTHS[mo] ?? "",
          year: y,
          hour: h,
          part_of_day: partOfDay(h),
        },
      };
    },
  }),

  date_diff: def({
    fn: "date_diff",
    label: "Time between dates",
    description: "Days, weeks, months or years from one date to another (an age, days until a visit).",
    group: "Date and time",
    icon: "timer",
    fields: { from: dateSource.default("today"), to: dateSource.default("today"), timezone },
    defaults: () => ({ from: "today", to: "", timezone: "Asia/Kolkata" }),
    parts: ["days", "weeks", "months", "years"],
    failLabel: "Not a date",
    summary: (c) => `From ${sourceLabel(c.from)} to ${c.to ? sourceLabel(c.to) : "…"}`,
    refs: (c) =>
      [c.from, c.to].filter((p) => p && p !== "today").map((path) => ({ path, kind: "date" as const })),
    texts: () => [],
    compute: (c, io) => {
      const today = zonedDate(io.now, c.timezone);
      const read = (s: string) => (s === "today" ? today : readDate(io.read(s), c.timezone));
      const a = read(c.from);
      const b = read(c.to);
      if (!a || !b) return { ok: false, reason: "not_a_date" };
      const days = daysBetween(a, b);
      const months = wholeMonths(a, b);
      return {
        ok: true,
        value: {
          text: `${days} ${Math.abs(days) === 1 ? "day" : "days"}`,
          days,
          weeks: Math.trunc(days / 7),
          months,
          years: Math.trunc(months / 12),
        },
      };
    },
  }),

  calculate: def({
    fn: "calculate",
    label: "Calculate",
    description: "Work out a number from a formula, like a price or a total.",
    group: "Numbers",
    icon: "calculator",
    fields: {
      formula: z.string().trim().min(1, "Write the formula").max(500, "At most 500 characters"),
      decimals: z.number().int().min(0).max(4).default(2),
      currency: z.union([z.enum(currencies), z.literal("")]).default(""),
    },
    defaults: () => ({ formula: "", decimals: 2, currency: "" }),
    parts: ["number", "formatted"],
    failLabel: "Couldn't work it out",
    summary: (c) => c.formula || "Write the formula",
    refs: () => [],
    texts: (c) => [c.formula],
    check: (c) => formulaProblem(c.formula),
    compute: (c, io) => {
      try {
        const n = round(
          evaluateFormula(c.formula, (path, fallback) => {
            const raw = io.read(path);
            const v = raw && typeof raw === "object" ? (raw as { text?: unknown }).text : (raw as unknown);
            const n = readNumber(v === undefined || v === null || v === "" ? (fallback ?? "") : v);
            if (n === null) throw new NotANumber(path);
            return n;
          }),
          c.decimals,
        );
        const formatted = formatNumber(n, c.decimals, c.currency);
        return {
          ok: true,
          value: { text: c.currency ? formatted : String(n), number: n, formatted },
        };
      } catch (err) {
        if (err instanceof NotANumber) return { ok: false, reason: `not_a_number:${err.what}` };
        return { ok: false, reason: err instanceof FormulaError ? err.message : "formula" };
      }
    },
  }),

  change_text: def({
    fn: "change_text",
    label: "Change text",
    description: "Tidy a text: Title Case, capitals, the first word, or shorter.",
    group: "Text",
    icon: "text",
    fields: {
      text: z.string().max(4096).default(""),
      mode: z.enum(["title", "upper", "lower", "first_word", "shorten"]).default("title"),
      maxLength: z.number().int().min(1).max(1000).default(20),
    },
    defaults: () => ({ text: "", mode: "title", maxLength: 20 }),
    parts: [],
    summary: (c) =>
      ({
        title: "Title Case",
        upper: "CAPITALS",
        lower: "lower case",
        first_word: "First word",
        shorten: `At most ${c.maxLength} characters`,
      })[c.mode],
    refs: () => [],
    texts: (c) => [c.text],
    check: (c) => (c.text.trim() ? null : "Pick the text to change"),
    compute: (c, io) => changeText(c, io.fill(c.text)),
  }),

  find_in_text: def({
    fn: "find_in_text",
    label: "Find in text",
    description: "Pick a number, email, phone, PIN code or link out of a message.",
    group: "Text",
    icon: "search",
    fields: {
      text: z.string().max(4096).default(""),
      find: z.enum(["number", "email", "phone", "pincode", "link"]).default("number"),
    },
    defaults: () => ({ text: "{{trigger.text}}", find: "number" }),
    parts: ["all", "count"],
    failLabel: "Not found",
    summary: (c) =>
      ({
        number: "A number",
        email: "An email",
        phone: "A phone number",
        pincode: "A PIN code",
        link: "A link",
      })[c.find],
    refs: () => [],
    texts: (c) => [c.text],
    check: (c) => (c.text.trim() ? null : "Pick the text to look in"),
    compute: (c, io) => findInText(c, io.fill(c.text)),
  }),

  reference_code: def({
    fn: "reference_code",
    label: "Reference code",
    description: "A short random code for a booking or ticket, like BK-7K4Q9P.",
    group: "Generators",
    icon: "hash",
    fields: {
      prefix: z
        .string()
        .trim()
        .max(10, "At most 10 characters")
        .regex(/^[A-Za-z0-9_-]*$/, "Use letters, digits, - or _")
        .default(""),
      length: z.number().int().min(4).max(12).default(6),
      chars: z.enum(["both", "digits", "letters"]).default("both"),
    },
    defaults: () => ({ prefix: "", length: 6, chars: "both" }),
    parts: ["code"],
    summary: (c) => `${c.prefix}${"X".repeat(c.length)}`,
    refs: () => [],
    texts: () => [],
    compute: (c, io) => {
      const alphabet =
        c.chars === "digits" ? REF_DIGITS : c.chars === "letters" ? REF_LETTERS : REF_DIGITS + REF_LETTERS;
      let code = "";
      for (let i = 0; i < c.length; i++) code += alphabet[io.randomInt(alphabet.length)];
      return { ok: true, value: { text: `${c.prefix}${code}`, code } };
    },
  }),

  lookup: def({
    fn: "lookup",
    label: "Lookup table",
    description: "Turn one value into another: a city into its branch phone, a service into its price.",
    group: "Lookup",
    icon: "table",
    fields: {
      key: z.string().max(1024).default(""),
      rows: z
        .array(
          z.object({
            key: z.string().trim().min(1, "Every row needs a value to match").max(200),
            value: z.string().max(1024).default(""),
          }),
        )
        .min(1, "Add at least one row")
        .max(100, "At most 100 rows"),
      fallback: z.string().max(1024).default(""),
    },
    defaults: () => ({ key: "", rows: [{ key: "", value: "" }], fallback: "" }),
    parts: ["key"],
    okLabel: "Found",
    failLabel: "Not found",
    summary: (c) => `${c.rows.length} ${c.rows.length === 1 ? "row" : "rows"}`,
    refs: () => [],
    texts: (c) => [c.key],
    check: (c) => {
      if (!c.key.trim()) return "Pick the value to look up";
      const seen = new Set<string>();
      for (const r of c.rows) {
        const k = r.key.trim().toLowerCase();
        if (seen.has(k)) return `Two rows match “${r.key}”`;
        seen.add(k);
      }
      return null;
    },
    compute: (c, io) => {
      const k = io.fill(c.key).trim().toLowerCase();
      const row = k ? c.rows.find((r) => r.key.trim().toLowerCase() === k) : undefined;
      if (row) return { ok: true, value: { text: row.value, key: row.key } };
      return { ok: false, reason: "not_found", value: { text: c.fallback, key: "" } };
    },
  }),
} as const;

export type UtilityFn = keyof typeof utilityFunctions;
export const utilityFns = Object.keys(utilityFunctions) as UtilityFn[];
export type AnyUtilityDef = Def<z.ZodRawShape>;

export function utilityDef(fn: string): AnyUtilityDef | null {
  return (utilityFunctions as unknown as Record<string, AnyUtilityDef>)[fn] ?? null;
}

const variants = utilityFns.map((fn) => {
  const d = utilityFunctions[fn] as unknown as AnyUtilityDef;
  return z.object({ ...d.fields, fn: z.literal(fn), saveAs: savedValueName });
});

/** The settings of a Utility step: which function, its fields, and the name its result is saved as. */
export const utilityConfigSchema = z.discriminatedUnion(
  "fn",
  variants as unknown as [(typeof variants)[number], ...(typeof variants)[number][]],
);
export type UtilityConfig = { fn: UtilityFn; saveAs: string } & Record<string, unknown>;

/** A new Utility step's settings for a function. */
export function utilityDefaults(fn: UtilityFn, saveAs: string): UtilityConfig {
  const d = utilityFunctions[fn] as unknown as AnyUtilityDef;
  return { ...(d.defaults() as Record<string, unknown>), fn, saveAs };
}

/** Runs a Utility step's function. */
export function runUtility(config: UtilityConfig, io: UtilityIO): UtilityResult {
  const d = utilityDef(config.fn);
  if (!d) return { ok: false, reason: "unknown_function" };
  return d.compute(config as never, io);
}
