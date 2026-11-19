import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultBookingSettings, freeTimes, zonedTime } from "../src/bookings";
import {
  deleteGoogleEvent,
  exchangeGoogleCode,
  type GoogleError,
  getGoogleEvent,
  googleAuthUrl,
  googleConfig,
  googleFreeBusy,
  insertGoogleEvent,
  listOwnedCalendars,
  patchGoogleEvent,
  refreshGoogleToken,
} from "../src/google-calendar";
import { createFakeGoogle } from "./fake-google";

const tz = "Asia/Dubai";
const at = (hhmm: string) =>
  zonedTime("2030-01-08", Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), tz);

describe("Google Calendar", () => {
  it("asks for offline access with the narrow calendar scopes, back to the web app", () => {
    const cfg = googleConfig({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "s",
      WEB_URL: "https://app.relay.operium.pro/",
    });
    assert.ok(cfg);
    const url = new URL(googleAuthUrl(cfg, "st"));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://app.relay.operium.pro/api/bookings/google/callback",
    );
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.match(url.searchParams.get("scope") ?? "", /calendar\.events\.owned/);
    assert.doesNotMatch(
      url.searchParams.get("scope") ?? "",
      /auth\/calendar(\s|$)/,
      "never the full calendar scope",
    );
    assert.equal(googleConfig({ WEB_URL: "http://x" }), null);
  });

  it("connects, lists only owned calendars, refreshes, and reports a revoked grant", async () => {
    const g = createFakeGoogle();
    const t = await exchangeGoogleCode(g.config, "good-code");
    assert.equal(t.refreshToken, "rt-1");
    assert.equal(t.email, "owner@lumen.test");
    const cals = await listOwnedCalendars(g.config, t.accessToken);
    assert.deepEqual(
      cals.map((c) => c.id),
      ["owner@lumen.test", "team@group"],
    );
    const fresh = await refreshGoogleToken(g.config, "rt-1");
    assert.ok(fresh.accessToken.startsWith("at-"));
    await assert.rejects(
      refreshGoogleToken(g.config, "rt-revoked"),
      (e: GoogleError) => e.kind === "invalid_grant",
    );
  });

  it("reads busy times, which close a time whatever the capacity", async () => {
    const g = createFakeGoogle();
    const t = await exchangeGoogleCode(g.config, "good-code");
    g.state.busy = [{ start: at("10:00").toISOString(), end: at("11:00").toISOString() }];
    const busy = await googleFreeBusy(g.config, t.accessToken, "owner@lumen.test", at("00:00"), at("23:59"));
    assert.equal(busy.length, 1);
    const times = freeTimes({
      settings: {
        ...defaultBookingSettings,
        minNoticeMinutes: 0,
        hours: [{ day: 2, from: "09:00", to: "12:00" }],
      },
      timezone: tz,
      durationMinutes: 30,
      capacity: 5,
      busy: [],
      blocked: busy,
      now: new Date("2030-01-01T00:00:00Z"),
      from: at("00:00"),
      to: at("23:59"),
    });
    assert.deepEqual(
      times.map((x) => x.toISOString()),
      [at("09:00"), at("09:30"), at("11:00"), at("11:30")].map((x) => x.toISOString()),
    );
  });

  it("adds a free event with a Meet link that may come later, then moves and deletes it", async () => {
    const g = createFakeGoogle();
    const t = await exchangeGoogleCode(g.config, "good-code");
    const input = {
      summary: "Consultation · Asha",
      description: "Ref K7P2QD",
      start: at("10:00"),
      end: at("10:30"),
      timeZone: tz,
    };
    const made = await insertGoogleEvent(g.config, t.accessToken, "owner@lumen.test", input, {
      meetRequestId: "bkg_1",
    });
    assert.equal(made.meetStatus, "pending");
    assert.equal(made.meetUrl, null);
    const sent = g.state.events[0];
    assert.equal(sent?.body.transparency, "transparent");
    assert.match(g.state.calls.at(-1) ?? "", /POST/);
    const later = await getGoogleEvent(g.config, t.accessToken, "owner@lumen.test", made.id);
    assert.equal(later.meetStatus, "success");
    assert.match(later.meetUrl ?? "", /^https:\/\/meet\.google\.com\//);
    const moved = await patchGoogleEvent(g.config, t.accessToken, "owner@lumen.test", made.id, {
      ...input,
      start: at("11:00"),
      end: at("11:30"),
    });
    assert.equal(moved.id, made.id);
    assert.equal(
      (sent?.body.start as { dateTime?: string } | undefined)?.dateTime,
      at("11:00").toISOString(),
    );
    await deleteGoogleEvent(g.config, t.accessToken, "owner@lumen.test", made.id);
    await deleteGoogleEvent(g.config, t.accessToken, "owner@lumen.test", made.id); // already gone: fine
    assert.equal(sent?.deleted, true);
  });

  it("retries Google's hiccups, then says so", async () => {
    const g = createFakeGoogle();
    const t = await exchangeGoogleCode(g.config, "good-code");
    g.state.failNext = 2;
    assert.equal((await listOwnedCalendars(g.config, t.accessToken)).length, 2, "two 503s, then fine");
    g.state.failNext = 5;
    await assert.rejects(listOwnedCalendars(g.config, t.accessToken), /Google answered 503/);
    g.state.failNext = 0;
    g.state.down = true;
    await assert.rejects(listOwnedCalendars(g.config, t.accessToken), /Couldn't reach Google/);
  });
});
