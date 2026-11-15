import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AskQuestionConfig } from "@relay/core/automations";
import { nextTimeOfDay, parseDate, readAnswer, withinBusinessHours } from "../src/automations/helpers";

const base = { text: "?", saveAs: "x", retries: 2, retryText: "", timeoutMinutes: 60 };
const typed = (format: "any" | "number" | "email" | "phone" | "date"): AskQuestionConfig => ({
  ...base,
  answer: { type: "text", format },
});
const say = (text: string) => ({ type: "text", text, reply: null });

describe("reading answers", () => {
  it("checks typed formats", () => {
    assert.deepEqual(
      readAnswer(typed("number"), say("1,250"), () => null),
      { handle: "next", value: "1250" },
    );
    assert.equal(
      readAnswer(typed("number"), say("lots"), () => null),
      null,
    );
    assert.equal(readAnswer(typed("email"), say("Asha@Example.com"), () => null)?.value, "asha@example.com");
    assert.equal(
      readAnswer(typed("email"), say("asha@"), () => null),
      null,
    );
    assert.equal(readAnswer(typed("phone"), say("+91 98470 12345"), () => null)?.value, "919847012345");
    assert.equal(readAnswer(typed("date"), say("15/11/2026"), () => null)?.value, "2026-11-15");
    assert.equal(
      readAnswer(typed("any"), say("   "), () => null),
      null,
    );
  });
  it("accepts a tapped option, its title or its number", () => {
    const q: AskQuestionConfig = {
      ...base,
      answer: {
        type: "buttons",
        options: [
          { id: "a1", title: "Prices" },
          { id: "a2", title: "Talk to us" },
        ],
      },
    };
    const mine = (id: string) => (id.startsWith("qx_") ? id.slice(3) : null);
    assert.equal(
      readAnswer(q, { type: "interactive", text: "Prices", reply: { id: "qx_a1", title: "Prices" } }, mine)
        ?.handle,
      "opt:a1",
    );
    assert.equal(
      readAnswer(q, { type: "interactive", text: "Prices", reply: { id: "qy_a1", title: "Prices" } }, mine),
      null,
    );
    assert.equal(readAnswer(q, say("talk to US"), mine)?.handle, "opt:a2");
    assert.equal(readAnswer(q, say("2"), mine)?.handle, "opt:a2");
    assert.equal(readAnswer(q, say("3"), mine), null);
  });
  it("refuses impossible dates", () => {
    assert.equal(parseDate("31/02/2026"), null);
    assert.equal(parseDate("2026-02-28"), "2026-02-28");
  });
});

describe("time", () => {
  it("knows business hours in the business's timezone", () => {
    const rule = {
      kind: "business_hours" as const,
      days: [1, 2, 3, 4, 5],
      from: "09:00",
      to: "18:00",
      timezone: "Asia/Kolkata",
    };
    // Monday 2026-11-16 05:00 UTC = 10:30 in India.
    assert.equal(withinBusinessHours(rule, new Date("2026-11-16T05:00:00Z")), true);
    // Sunday.
    assert.equal(withinBusinessHours(rule, new Date("2026-11-15T05:00:00Z")), false);
    // Monday 13:00 UTC = 18:30 in India.
    assert.equal(withinBusinessHours(rule, new Date("2026-11-16T13:00:00Z")), false);
  });
  it("finds the next time of day", () => {
    const now = new Date("2026-11-16T05:00:00Z"); // 10:30 IST
    assert.equal(nextTimeOfDay("11:00", "Asia/Kolkata", now).toISOString(), "2026-11-16T05:30:00.000Z");
    assert.equal(nextTimeOfDay("09:00", "Asia/Kolkata", now).toISOString(), "2026-11-17T03:30:00.000Z");
  });
});
