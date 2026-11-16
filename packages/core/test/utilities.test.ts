import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AutomationDefinition,
  type AutomationNode,
  compare,
  dateMatches,
  describeRun,
  distanceMeters,
  emptyDefinition,
  formulaProblem,
  locationAnswer,
  nodeSpecs,
  readDate,
  resolveText,
  runUtility,
  type UtilityConfig,
  type UtilityIO,
  utilityDefaults,
  validateDefinition,
} from "../src/automations/index";

const node = (
  id: string,
  type: keyof typeof nodeSpecs,
  config?: Record<string, unknown>,
): AutomationNode => ({
  id,
  type,
  version: 1,
  config: config ?? (nodeSpecs[type].defaults() as Record<string, unknown>),
});
const edge = (source: string, sourceHandle: string, target: string) => ({
  id: `${source}-${sourceHandle}-${target}`,
  source,
  sourceHandle,
  target,
});
const codes = (def: AutomationDefinition) => validateDefinition(def).map((i) => `${i.level}:${i.code}`);

const pickup = locationAnswer({ latitude: 25.1972, longitude: 55.2744, name: "Dubai Mall" });
const burjAlArab = { name: "Burj Al Arab", address: "", latitude: 25.1412, longitude: 55.1853 };

/** A run's saved data for the utilities: answers and contact, filled like {{variables}}. */
function io(over: Partial<UtilityIO> & { data?: Record<string, unknown> } = {}): UtilityIO {
  const scope = {
    contact: { name: "asha menon", ...((over.data?.contact as object) ?? {}) },
    trigger: { text: "my order no is 4521, call +971 50 123 4567" },
    answers: { pickup, typed: locationAnswer(null, "Marina Walk"), qty: "3", dob: "15/11/1990" },
    values: {},
    chat: {},
    business: {},
  };
  return {
    read: (path) => {
      let v: unknown = scope;
      for (const k of path.split("."))
        v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
      return v;
    },
    fill: (text) => resolveText(text, scope),
    now: new Date("2026-11-16T20:30:00Z"), // 02:00 on the 17th in Kolkata, 00:30 on the 17th in Dubai
    randomInt: (n) => n - 1,
    ...over,
  };
}
const run = (fn: Parameters<typeof utilityDefaults>[0], config: Record<string, unknown>, o?: UtilityIO) =>
  runUtility({ ...utilityDefaults(fn, "x"), ...config } as UtilityConfig, o ?? io());

describe("dates and comparing", () => {
  it("reads dates the way they're written, and timestamps as their day in a timezone", () => {
    assert.equal(readDate("15/11/2026", "Asia/Dubai"), "2026-11-15");
    assert.equal(readDate("2026-11-16T20:30:00.000Z", "Asia/Kolkata"), "2026-11-17");
    assert.equal(readDate("2026-11-16T20:30:00.000Z", "UTC"), "2026-11-16");
    assert.equal(readDate("soon", "UTC"), null);
    assert.equal(readDate("3", "UTC"), null);
    // A worked-out date ({{values.next}}) is read by its day, other results by their text.
    assert.equal(readDate({ text: "Tue, 17 Nov 2026", date: "2026-11-17" }, "UTC"), "2026-11-17");
    assert.equal(readDate({ text: "17/11/2026" }, "UTC"), "2026-11-17");
  });

  it("matches date rules against today", () => {
    const today = "2026-11-16";
    const m = (date: string | null, rule: Record<string, unknown>) =>
      dateMatches(date, { op: "is_today", ...rule }, today);
    assert.ok(m("2026-11-16", {}));
    assert.ok(m("2026-11-17", { op: "is_tomorrow" }));
    assert.ok(m("2026-11-19", { op: "in_next_days", days: 3 }));
    assert.ok(!m("2026-11-20", { op: "in_next_days", days: 3 }));
    assert.ok(m("2026-11-10", { op: "in_last_days", days: 7 }));
    assert.ok(m("2026-12-30", { op: "more_than_days_away", days: 30 }));
    assert.ok(m("2026-10-01", { op: "more_than_days_ago", days: 30 }));
    assert.ok(m("2026-12-25", { op: "between", date: "2026-12-26", to: "2026-12-24" }));
    assert.ok(m("2026-11-16", { op: "weekday_in", weekdays: [1] })); // a Monday
    assert.ok(m(null, { op: "not_a_date" }));
    assert.ok(!m(null, { op: "is_past" }));
  });

  it("compares values, numbers written with commas and currency included", () => {
    assert.ok(compare("Dubai", "is_one_of", "Abu Dhabi, dubai , Sharjah"));
    assert.ok(compare("₹ 1,200", "gt", "999"));
    assert.ok(!compare("abc", "gt", "1"));
    assert.ok(compare("hello there", "starts_with", "Hello"));
    assert.ok(compare("hello", "not_contains", "bye"));
  });
});

describe("utilities", () => {
  it("measures distance as the crow flies, and needs a pin", () => {
    const km =
      distanceMeters({ latitude: 9.9312, longitude: 76.2673 }, { latitude: 12.9716, longitude: 77.5946 }) /
      1000;
    assert.ok(km > 355 && km < 370, `Kochi–Bengaluru ${km}`);
    const r = run("distance", { from: "answers.pickup", to: { kind: "place", place: burjAlArab } });
    assert.ok(r.ok);
    assert.deepEqual(r.ok && [r.value.km, r.value.text, r.value.meters], [10.9, "10.9 km", 10917]);
    const typed = run("distance", { from: "answers.typed", to: { kind: "place", place: burjAlArab } });
    assert.deepEqual(typed, { ok: false, reason: "no_pin" });
  });

  it("finds the nearest place", () => {
    const r = run("nearest", {
      from: "answers.pickup",
      places: [
        { name: "Marina", address: "", latitude: 25.08, longitude: 55.14 },
        { name: "Downtown", address: "Boulevard", latitude: 25.195, longitude: 55.28 },
      ],
    });
    assert.ok(r.ok);
    assert.equal(r.ok && r.value.name, "Downtown");
    assert.match(String(r.ok && r.value.distance), /^\d{3} m$/);
  });

  it("works out dates in the business's timezone", () => {
    const kolkata = run("date_time", { start: "today", show: "date_time", timezone: "Asia/Kolkata" });
    assert.ok(kolkata.ok);
    assert.equal(kolkata.ok && kolkata.value.date, "2026-11-17");
    assert.equal(kolkata.ok && kolkata.value.text, "Tue, 17 Nov 2026, 2:00 am");
    assert.equal(kolkata.ok && kolkata.value.part_of_day, "night");
    const utc = run("date_time", { start: "today", timezone: "UTC" });
    assert.equal(utc.ok && utc.value.date, "2026-11-16");
    // 31 Jan + 1 month is the end of February.
    const leap = run(
      "date_time",
      {
        start: "answers.d",
        change: "add",
        amount: 1,
        unit: "months",
        timezone: "UTC",
      },
      io({ read: () => "2028-01-31" }),
    );
    assert.equal(leap.ok && leap.value.date, "2028-02-29");
    const back = run("date_time", {
      start: "today",
      change: "subtract",
      amount: 2,
      unit: "weeks",
      timezone: "UTC",
    });
    assert.equal(back.ok && back.value.date, "2026-11-02");
    assert.deepEqual(run("date_time", { start: "answers.qty", timezone: "UTC" }).ok, false);
  });

  it("counts the time between dates, an age across a birthday", () => {
    const age = run("date_diff", { from: "answers.dob", to: "today", timezone: "UTC" });
    assert.ok(age.ok);
    assert.equal(age.ok && age.value.years, 36);
    const before = run(
      "date_diff",
      { from: "answers.dob", to: "today", timezone: "UTC" },
      io({ now: new Date("2026-11-14T12:00:00Z") }),
    );
    assert.equal(before.ok && before.value.years, 35);
    const until = run(
      "date_diff",
      { from: "today", to: "answers.d", timezone: "UTC" },
      io({ read: () => "2026-11-28" }),
    );
    assert.equal(until.ok && until.value.text, "12 days");
  });

  it("calculates without running code", () => {
    const r = run("calculate", { formula: "{{answers.qty}} * 250 + 50", currency: "INR" });
    assert.deepEqual(r.ok && [r.value.number, r.value.text], [800, "₹800"]);
    const prec = run("calculate", { formula: "round((10 + 5) / 4, 1) + max(1, 2) - 2 % 3", decimals: 2 });
    assert.equal(prec.ok && prec.value.number, 3.8);
    const big = run("calculate", { formula: "1234567.5", currency: "AED", decimals: 2 });
    assert.ok(big.ok && /1,234,567\.5/.test(big.value.text), big.ok ? big.value.text : "");
    const lakh = run("calculate", { formula: "1234567", currency: "INR", decimals: 0 });
    assert.equal(lakh.ok && lakh.value.text, "₹12,34,567");
    assert.deepEqual(run("calculate", { formula: "{{contact.name}} + 1" }), {
      ok: false,
      reason: "not_a_number:contact.name",
    });
    assert.deepEqual(run("calculate", { formula: "{{answers.missing|2}} * 3" }).ok, true);
    assert.equal(run("calculate", { formula: "1 / 0" }).ok, false);
    assert.equal(formulaProblem("2 * (3 + "), "The formula has a mistake near the end.");
    assert.equal(formulaProblem("alert(1)"), "The formula has a mistake near “alert”.");
    assert.equal(formulaProblem("{{answers.qty}} * 2"), null);
  });

  it("changes and searches text", () => {
    assert.equal(run("change_text", { text: "{{contact.name}}", mode: "title" }).ok && "ok", "ok");
    const title = run("change_text", { text: "{{contact.name}}", mode: "title" });
    assert.equal(title.ok && title.value.text, "Asha Menon");
    const short = run("change_text", { text: "abcdefghij", mode: "shorten", maxLength: 5 });
    assert.equal(short.ok && short.value.text, "abcd…");
    const num = run("find_in_text", { text: "{{trigger.text}}", find: "number" });
    assert.equal(num.ok && num.value.text, "4521");
    const phone = run("find_in_text", { text: "{{trigger.text}}", find: "phone" });
    assert.equal(phone.ok && phone.value.text, "+971501234567");
    assert.deepEqual(run("find_in_text", { text: "{{trigger.text}}", find: "email" }), {
      ok: false,
      reason: "not_found",
    });
  });

  it("makes reference codes and looks values up", () => {
    const code = run("reference_code", { prefix: "BK-", length: 6, chars: "both" });
    assert.equal(code.ok && code.value.text, "BK-ZZZZZZ"); // randomInt always picks the last character
    const digits = run("reference_code", { length: 4, chars: "digits" });
    assert.equal(digits.ok && digits.value.text, "9999");
    const rows = [
      { key: "Dubai", value: "+971 4 000 0000" },
      { key: "Kochi", value: "+91 484 000 000" },
    ];
    const found = run("lookup", { key: " DUBAI ", rows });
    assert.equal(found.ok && found.value.text, "+971 4 000 0000");
    assert.deepEqual(run("lookup", { key: "Paris", rows, fallback: "our main line" }), {
      ok: false,
      reason: "not_found",
      value: { text: "our main line", key: "" },
    });
  });
});

/** Ask for location → Distance → Branch near/far. */
function nearOrFar(): AutomationDefinition {
  const def = emptyDefinition({
    type: "message_received",
    mode: "keyword",
    keywords: ["pickup"],
    match: "exact",
  });
  def.nodes = [
    node("where", "ask_location", { text: "Where are you?", saveAs: "pickup" }),
    node("dist", "utility", {
      ...utilityDefaults("distance", "dist"),
      from: "answers.pickup",
      to: { kind: "place", place: burjAlArab },
    }),
    node("split", "branch", {
      paths: [
        {
          id: "near",
          name: "Near",
          match: "all",
          rules: [{ kind: "variable", name: "values.dist.km", op: "lt", value: "5" }],
        },
        {
          id: "far",
          name: "Far",
          match: "all",
          rules: [{ kind: "variable", name: "values.dist.km", op: "lt", value: "50" }],
        },
      ],
    }),
    node("near", "send_message", { text: "You're {{values.dist}} away", media: null }),
    node("far", "send_message", { text: "That's {{values.dist.km}} km", media: null }),
    node("bye", "end", {}),
  ];
  def.edges = [
    edge("trigger", "next", "where"),
    edge("where", "next", "dist"),
    edge("where", "invalid", "bye"),
    edge("where", "no_reply", "bye"),
    edge("dist", "next", "split"),
    edge("dist", "failed", "bye"),
    edge("split", "path:near", "near"),
    edge("split", "path:far", "far"),
    edge("split", "else", "bye"),
  ];
  return def;
}

describe("branch and utility validation", () => {
  it("accepts a wired near/far automation", () => {
    assert.deepEqual(
      codes(nearOrFar()).filter((c) => c.startsWith("error")),
      [],
    );
    assert.deepEqual(codes(nearOrFar()), []);
  });

  it("names unwired paths and Otherwise", () => {
    const def = nearOrFar();
    def.edges = def.edges.filter((e) => e.sourceHandle !== "else" && e.sourceHandle !== "path:far");
    const issues = validateDefinition(def)
      .filter((i) => i.code === "BRANCH_UNWIRED")
      .map((i) => i.message);
    assert.deepEqual(issues, [
      "The “Far” path ends the automation.",
      "The “Otherwise” way ends the automation.",
    ]);
  });

  it("checks values, parts, names and inputs", () => {
    const def = nearOrFar();
    const far = def.nodes.find((n) => n.id === "far") as AutomationNode;
    far.config = { text: "{{values.dist.minutes}} {{values.nope}}", media: null };
    const dist = def.nodes.find((n) => n.id === "dist") as AutomationNode;
    dist.config = { ...dist.config, saveAs: "pickup", from: "answers.nothing" };
    const c = codes(def);
    assert.ok(c.includes("error:VALUE_PART") || c.includes("error:VALUE_MISSING"), c.join());
    assert.ok(c.includes("error:VALUE_NAME_CLASH"), c.join());
    assert.ok(c.includes("error:UTILITY_INPUT"), c.join());
  });

  it("checks formulas, duplicate paths and date rules", () => {
    const def = nearOrFar();
    def.nodes.push(
      node("calc", "utility", { ...utilityDefaults("calculate", "total"), formula: "2 *" }),
      node("when", "condition", {
        match: "all",
        rules: [
          { kind: "date", source: "today", op: "is_past", timezone: "UTC" },
          { kind: "date", source: "answers.pickup", op: "in_next_days", timezone: "UTC" },
        ],
      }),
    );
    const split = def.nodes.find((n) => n.id === "split") as AutomationNode;
    const paths = (split.config as { paths: Record<string, unknown>[] }).paths;
    paths[1] = { ...paths[1], name: "near" };
    const c = codes(def);
    for (const code of ["error:UTILITY_SETTINGS", "error:PATH_DUPLICATE", "error:DATE_RULE"])
      assert.ok(c.includes(code), `${code} in ${c.join()}`);
  });
});

describe("history of branches and utilities", () => {
  it("says which path was taken and what was worked out", () => {
    const def = nearOrFar();
    const at = "2026-11-16T10:00:00.000Z";
    const step = (name: string, result: unknown) => ({
      name,
      kind: "step",
      status: "completed",
      result,
      error: null,
      startedAt: at,
      completedAt: at,
      wakeAt: null,
    });
    const history = describeRun({
      def,
      input: {
        organizationId: "o",
        automationId: "a",
        versionId: "v",
        conversationId: "c",
        contactId: "k",
        trigger: { kind: "message", text: "pickup" },
      } as never,
      steps: [
        step("utility:dist#1", { ok: true, value: { text: "10.9 km", km: 10.9 } }),
        step("branch:split#1", "path:far"),
        step("utility:dist#2", { ok: false, reason: "no_pin" }),
        step("branch:split#2", "else"),
      ],
      messages: {},
      status: "completed",
      error: null,
      createdAt: at,
      finishedAt: at,
    });
    const texts = history.map((h) => h.text);
    assert.ok(texts.includes("Distance between places: “10.9 km”"), texts.join(" | "));
    assert.ok(texts.includes("Took the “Far” path"));
    assert.ok(texts.includes("Distance between places: No pin shared"));
    assert.ok(texts.includes("No path matched: took “Otherwise”"));
    assert.deepEqual(
      history.filter((h) => h.saved).map((h) => h.saved),
      [{ name: "dist", value: "10.9 km" }],
    );
  });
});
