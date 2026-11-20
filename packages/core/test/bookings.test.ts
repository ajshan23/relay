import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bookingRangeLabel,
  bookingReplyId,
  bookingReplyOf,
  bookingSettingsSchema,
  bookingTimeLabel,
  defaultBookingSettings,
  freeTimes,
  isOfferedTime,
  localTime,
  phoneTimezone,
  timezonePlace,
  zonedTime,
} from "../src/bookings";

const tz = "Asia/Dubai"; // UTC+4, no DST
const base = { ...defaultBookingSettings, minNoticeMinutes: 0 };
// Friday 20 Nov 2026, 08:00 in Dubai.
const now = new Date("2026-11-20T04:00:00Z");
const day = (date: string) => ({ from: zonedTime(date, 0, tz), to: zonedTime(date, 24 * 60, tz) });
const local = (d: Date) => {
  const l = localTime(d, tz);
  return `${String(Math.floor(l.minute / 60)).padStart(2, "0")}:${String(l.minute % 60).padStart(2, "0")}`;
};

describe("free times", () => {
  it("offers starts within opening hours, on the step, with room for the whole booking", () => {
    const times = freeTimes({
      settings: { ...base, hours: [{ day: 5, from: "09:00", to: "11:00" }] },
      timezone: tz,
      durationMinutes: 45,
      capacity: 1,
      busy: [],
      now,
      ...day("2026-11-20"),
    });
    assert.deepEqual(times.map(local), ["09:00", "09:30", "10:00"]);
  });

  it("keeps a place free up to capacity, with the gap after each booking", () => {
    const s = { ...base, hours: [{ day: 5, from: "09:00", to: "11:00" }], stepMinutes: 30 };
    const at = (t: string) => zonedTime("2026-11-20", Number(t.slice(0, 2)) * 60 + Number(t.slice(3)), tz);
    const busy = [{ start: at("09:00"), end: at("09:30") }];
    const one = freeTimes({
      settings: s,
      timezone: tz,
      durationMinutes: 30,
      capacity: 1,
      busy,
      now,
      ...day("2026-11-20"),
    });
    assert.deepEqual(one.map(local), ["09:30", "10:00", "10:30"]);
    const two = freeTimes({
      settings: s,
      timezone: tz,
      durationMinutes: 30,
      capacity: 2,
      busy,
      now,
      ...day("2026-11-20"),
    });
    assert.deepEqual(two.map(local), ["09:00", "09:30", "10:00", "10:30"]);
    const gap = freeTimes({
      settings: { ...s, bufferMinutes: 15 },
      timezone: tz,
      durationMinutes: 30,
      capacity: 1,
      busy,
      now,
      ...day("2026-11-20"),
    });
    assert.deepEqual(gap.map(local), ["10:00", "10:30"], "09:30 is inside the 15-minute gap");
  });

  it("respects closed days, closed dates, notice and how far ahead", () => {
    const s = { ...base, closedDates: ["2026-11-21"], minNoticeMinutes: 120, maxDaysAhead: 4 };
    const times = freeTimes({
      settings: s,
      timezone: tz,
      durationMinutes: 60,
      capacity: 1,
      busy: [],
      now,
      from: now,
      to: new Date(now.getTime() + 10 * 86_400_000),
    });
    const dates = [...new Set(times.map((t) => localTime(t, tz).date))];
    // Fri 20 from 10:00 (two hours' notice), Sat 21 a closed date, Sun 22 no hours, Mon 23, then 4 days are up.
    assert.deepEqual(dates, ["2026-11-20", "2026-11-23"]);
    assert.equal(local(times[0] as Date), "10:00");
  });

  it("handles a day when the clocks change", () => {
    // London: clocks go back at 02:00 on Sun 25 Oct 2026.
    const london = "Europe/London";
    const start = zonedTime("2026-10-25", 10 * 60, london);
    assert.equal(start.toISOString(), "2026-10-25T10:00:00.000Z");
    assert.equal(zonedTime("2026-10-24", 10 * 60, london).toISOString(), "2026-10-24T09:00:00.000Z");
    const times = freeTimes({
      settings: { ...base, hours: [{ day: 7, from: "10:00", to: "11:00" }] },
      timezone: london,
      durationMinutes: 60,
      capacity: 1,
      busy: [],
      now: new Date("2026-10-20T00:00:00Z"),
      from: zonedTime("2026-10-25", 0, london),
      to: zonedTime("2026-10-26", 0, london),
    });
    assert.deepEqual(
      times.map((t) => t.toISOString()),
      ["2026-10-25T10:00:00.000Z"],
    );
  });

  it("checks a start is one the business offers, labels times, and reads reminder taps", () => {
    const input = { settings: base, timezone: tz, durationMinutes: 30, capacity: 1, now };
    assert.equal(isOfferedTime(input, zonedTime("2026-11-20", 9 * 60 + 30, tz)), true);
    assert.equal(isOfferedTime(input, zonedTime("2026-11-20", 9 * 60 + 10, tz)), false, "off the step");
    assert.equal(isOfferedTime(input, zonedTime("2026-11-22", 10 * 60, tz)), false, "closed on Sunday");
    assert.equal(bookingTimeLabel(zonedTime("2026-11-20", 17 * 60, tz), tz), "Fri 20 Nov, 5:00 pm");
    assert.deepEqual(bookingReplyOf(bookingReplyId("bkg_1", "change")), {
      bookingId: "bkg_1",
      answer: "change",
    });
    assert.equal(bookingReplyOf("q1_yes"), null);
    assert.equal(
      bookingSettingsSchema.safeParse({ ...base, hours: [{ day: 1, from: "10:00", to: "09:00" }] }).success,
      false,
    );
  });
});

describe("the customer's own time", () => {
  it("knows where a number is from, only for countries with one timezone", () => {
    assert.deepEqual(phoneTimezone("919876543210"), { place: "India", timezone: "Asia/Kolkata" });
    assert.deepEqual(phoneTimezone("+973 3612 3456"), { place: "Bahrain", timezone: "Asia/Bahrain" });
    assert.deepEqual(phoneTimezone("00971501234567"), { place: "UAE", timezone: "Asia/Dubai" });
    assert.equal(phoneTimezone("14155550123"), null, "the US has several timezones");
    assert.equal(phoneTimezone("97150"), null, "too short to be a number");
    assert.equal(phoneTimezone(null), null);
    assert.equal(timezonePlace("Asia/Dubai"), "UAE");
    assert.equal(timezonePlace("America/New_York"), "New York");
  });

  it("writes a time range the way people do", () => {
    const start = new Date("2026-11-21T13:30:00Z");
    const end = new Date("2026-11-21T14:00:00Z");
    assert.equal(bookingRangeLabel(start, end, "Asia/Dubai"), "5:30 – 6:00 pm");
    assert.equal(bookingRangeLabel(start, end, "Asia/Kolkata"), "7:00 – 7:30 pm");
    assert.equal(
      bookingRangeLabel(new Date("2026-11-21T07:30:00Z"), new Date("2026-11-21T08:15:00Z"), "Asia/Dubai"),
      "11:30 am – 12:15 pm",
    );
  });
});
