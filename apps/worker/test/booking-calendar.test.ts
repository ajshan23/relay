import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { encryptSecret, newId } from "@relay/core";
import { defaultBookingSettings, zonedTime } from "@relay/core/bookings";
import { googleEventIdFor } from "@relay/core/google-calendar";
import {
  type CalendarDeps,
  cleanGuestEmails,
  createBooking,
  createCatalogType,
  createDb,
  eq,
  findTimes,
  forgetGoogleBusy,
  moveBooking,
  retryCalendarSyncs,
  saveBookingGuests,
  saveBookingSettings,
  saveCatalogItem,
  schema,
  setBookingStatus,
} from "@relay/db";
import { createFakeGoogle } from "../../../packages/core/test/fake-google";
import { createBookingReminders } from "../src/bookings/reminders";

/*
 * Bookings with a branch's Google Calendar (a pretend Google): busy times close those times, each
 * booking becomes an event (online services with a Meet link), moves and cancels follow, Google
 * being down never stops a booking (the sweep catches up), and a revoked grant asks to reconnect.
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const T = `g${Date.now().toString(36)}`;
const ids = { org: `org_${T}`, branch: `br_${T}`, channel: `ch_${T}`, contact: `ct_${T}`, conv: `conv_${T}` };
const tz = "Asia/Dubai";
const day = "2030-01-08";
const at = (hhmm: string, date = day) =>
  zonedTime(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), tz);
const now = at("06:00", "2030-01-07");
const key = randomBytes(32).toString("base64");
const google = createFakeGoogle();
const calendar: CalendarDeps = { google: google.config, secretKey: key, appUrl: "https://app.test" };
let consult = "";
let haircut = "";

const book = (variantId: string, start: Date) =>
  createBooking(db, {
    id: newId("booking"),
    organizationId: ids.org,
    branchId: ids.branch,
    variantId,
    startsAt: start,
    contactId: ids.contact,
    conversationId: ids.conv,
    bookedBy: "ai",
    now,
    calendar,
  });
const eventOf = (bookingId: string) => google.state.events.find((e) => e.id === googleEventIdFor(bookingId));

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: ids.org, name: "Lumen Calendar Test", slug: `lumen-${T}`, createdAt: new Date() });
  await db
    .insert(schema.branch)
    .values({ id: ids.branch, organizationId: ids.org, name: "Marina", slug: `marina-${T}`, timezone: tz });
  await db.insert(schema.channelAccount).values({
    id: ids.channel,
    organizationId: ids.org,
    type: "whatsapp",
    provider: "meta",
    externalId: `pn_${T}`,
    displayName: "Calendar test",
    credentials: "test",
    status: "active",
    branchId: ids.branch,
  });
  await db.insert(schema.contact).values({
    id: ids.contact,
    organizationId: ids.org,
    branchId: ids.branch,
    name: "Asha",
    phone: "971500000009",
  });
  await db.insert(schema.contactIdentity).values({
    id: `cid_${T}`,
    organizationId: ids.org,
    contactId: ids.contact,
    branchId: ids.branch,
    channelType: "whatsapp",
    scope: "waba",
    externalId: "971500000009",
  });
  await db.insert(schema.conversation).values({
    id: ids.conv,
    organizationId: ids.org,
    branchId: ids.branch,
    channelAccountId: ids.channel,
    kind: "direct",
    contactId: ids.contact,
    contactIdentityId: `cid_${T}`,
    status: "open",
    windowExpiresAt: new Date(at("23:00").getTime() + 86_400_000),
  });
  await db
    .insert(schema.organizationSettings)
    .values({ organizationId: ids.org, catalog: { currency: "AED" } });
  const type = await createCatalogType(db, {
    organizationId: ids.org,
    name: "Services",
    kind: "service",
    template: "service",
    newId: (k) => newId(k),
  });
  for (const [title, online] of [
    ["Consultation", true],
    ["Haircut", false],
  ] as const) {
    const item = await saveCatalogItem(db, {
      organizationId: ids.org,
      branchId: ids.branch,
      userId: null,
      input: {
        typeId: type.id,
        title,
        description: "",
        attributes: {},
        status: "active",
        tags: [],
        variants: [
          {
            title: "",
            price: 100,
            currency: "AED",
            options: {},
            available: true,
            bookable: true,
            durationMinutes: 30,
            bookingCapacity: 3,
            bookingOnline: online,
          },
        ],
      },
      newId: (k) => newId(k),
    });
    const [v] = await db
      .select()
      .from(schema.catalogVariant)
      .where(eq(schema.catalogVariant.itemId, item.id));
    if (online) consult = v?.id ?? "";
    else haircut = v?.id ?? "";
  }
  await saveBookingSettings(db, ids.org, ids.branch, {
    ...defaultBookingSettings,
    enabled: true,
    hours: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, from: "09:00", to: "18:00" })),
    minNoticeMinutes: 0,
  });
  // Connected as Google would leave it after the consent screen.
  await db.insert(schema.calendarConnection).values({
    id: `cal_${T}`,
    organizationId: ids.org,
    branchId: ids.branch,
    accountEmail: "owner@lumen.test",
    refreshToken: encryptSecret("rt-1", key),
    calendarId: "owner@lumen.test",
    calendarName: "Lumen",
    calendars: [{ id: "owner@lumen.test", name: "Lumen", primary: true, timeZone: tz }],
    status: "active",
  });
});

after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, ids.org));
  await pg.end();
});

describe("Google Calendar for bookings", () => {
  it("doesn't offer or book times busy in Google, whatever the capacity", async () => {
    google.state.busy = [{ start: at("10:00").toISOString(), end: at("11:00").toISOString() }];
    forgetGoogleBusy();
    const free = await findTimes(db, {
      organizationId: ids.org,
      branchId: ids.branch,
      variantId: haircut,
      from: at("09:00"),
      to: at("12:00"),
      now,
      calendar,
    });
    assert.ok(free.ok);
    assert.deepEqual(
      free.times.map((t) => t.toISOString()),
      [at("09:00"), at("09:30"), at("11:00"), at("11:30")].map((t) => t.toISOString()),
    );
    const busy = await book(haircut, at("10:30"));
    assert.equal(!busy.ok && busy.reason, "busy");
    google.state.busy = [];
    forgetGoogleBusy();
  });

  it("puts a booking in Google (free, no emails) and gives online ones a Meet link", async () => {
    const res = await book(consult, at("14:00"));
    assert.ok(res.ok);
    assert.match(res.meetUrl ?? "", /^https:\/\/meet\.google\.com\//);
    const ev = eventOf(res.booking.id);
    assert.ok(ev, "added with Relay's own event id, so a retry can't add it twice");
    assert.equal(ev.body.transparency, "transparent");
    assert.match(String(ev.body.summary), /Consultation · Asha/);
    assert.match(String(ev.body.description), /Reference: [A-Z2-9]{6}/);
    assert.match(String(ev.body.description), /Chat: https:\/\/app\.test\/conversations/);
    assert.equal(ev.meetRequestId, res.booking.id);
    const [row] = await db.select().from(schema.booking).where(eq(schema.booking.id, res.booking.id));
    assert.equal(row?.calendarSync, "synced");
    assert.equal(row?.meetUrl, res.meetUrl);

    const plain = await book(haircut, at("15:00"));
    assert.ok(plain.ok);
    assert.equal(plain.meetUrl, null);
    assert.equal(eventOf(plain.booking.id)?.meetRequestId, null);
  });

  it("moves and cancels the event with the booking", async () => {
    const res = await book(haircut, at("16:00"));
    assert.ok(res.ok);
    const moved = await moveBooking(db, {
      organizationId: ids.org,
      bookingId: res.booking.id,
      startsAt: at("17:00"),
      now,
      calendar,
    });
    assert.ok(moved.ok);
    const ev = eventOf(res.booking.id);
    assert.equal((ev?.body.start as { dateTime?: string } | undefined)?.dateTime, at("17:00").toISOString());
    await setBookingStatus(db, {
      organizationId: ids.org,
      bookingId: res.booking.id,
      status: "cancelled",
      calendar,
    });
    assert.equal(ev?.deleted, true);
  });

  it("invites guests by email: Google emails them the invite, changes and cancellation", async () => {
    const res = await book(consult, at("12:00", "2030-01-10"));
    assert.ok(res.ok);
    const ev = eventOf(res.booking.id);
    assert.ok(ev);
    assert.equal(ev.body.attendees, undefined, "no guests: Google's list untouched");
    assert.deepEqual(ev.sendUpdates, ["none"], "and nobody emailed");

    assert.equal(cleanGuestEmails(["not an email"]), null);
    const guests = cleanGuestEmails([" Ajmal@Example.com ", "ajmal@example.com", "sara@example.org"]);
    assert.deepEqual(guests, ["ajmal@example.com", "sara@example.org"]);
    const saved = await saveBookingGuests(db, {
      organizationId: ids.org,
      bookingId: res.booking.id,
      guestEmails: guests ?? [],
      calendar,
    });
    assert.equal(saved?.sync.status, "synced");
    assert.deepEqual(saved?.booking.guestEmails, ["ajmal@example.com", "sara@example.org"]);
    assert.deepEqual(ev.body.attendees, [{ email: "ajmal@example.com" }, { email: "sara@example.org" }]);
    assert.equal(ev.sendUpdates.at(-1), "all", "Google emails the invite");

    // Another customer's booking can't be changed from their chat.
    const notTheirs = await saveBookingGuests(db, {
      organizationId: ids.org,
      bookingId: res.booking.id,
      guestEmails: [],
      contactId: "ct_someone_else",
      calendar,
    });
    assert.equal(notTheirs, null);

    const moved = await moveBooking(db, {
      organizationId: ids.org,
      bookingId: res.booking.id,
      startsAt: at("13:00", "2030-01-10"),
      now,
      calendar,
    });
    assert.ok(moved.ok);
    assert.equal(ev.sendUpdates.at(-1), "all", "guests hear about the new time");
    assert.equal(ev.body.attendees && (ev.body.attendees as unknown[]).length, 2);

    // The team removes one: the list follows, and the removed guest is told.
    await saveBookingGuests(db, {
      organizationId: ids.org,
      bookingId: res.booking.id,
      guestEmails: ["sara@example.org"],
      calendar,
    });
    assert.deepEqual(ev.body.attendees, [{ email: "sara@example.org" }]);
    await setBookingStatus(db, {
      organizationId: ids.org,
      bookingId: res.booking.id,
      status: "cancelled",
      calendar,
    });
    assert.equal(ev.deleted, true);
    assert.equal(ev.sendUpdates.at(-1), "all", "the guest gets the cancellation");
    const late = await saveBookingGuests(db, {
      organizationId: ids.org,
      bookingId: res.booking.id,
      guestEmails: ["x@example.com"],
      calendar,
    });
    assert.equal(late, null, "a cancelled booking takes no guests");
  });

  it("books even when Google is down, and the sweep puts it in later", async () => {
    google.state.down = true;
    const res = await book(haircut, at("09:00", "2030-01-09"));
    assert.ok(res.ok, "Relay's book still takes it");
    let [row] = await db.select().from(schema.booking).where(eq(schema.booking.id, res.booking.id));
    assert.equal(row?.calendarSync, "failed");
    assert.match(row?.calendarError ?? "", /Couldn't reach Google/);
    google.state.down = false;
    // Too soon after the failed try: waits. A few minutes later: done.
    await retryCalendarSyncs(db, calendar, new Date(Date.now() + 10_000));
    [row] = await db.select().from(schema.booking).where(eq(schema.booking.id, res.booking.id));
    assert.equal(row?.calendarSync, "failed");
    await retryCalendarSyncs(db, calendar, new Date(Date.now() + 5 * 60_000));
    [row] = await db.select().from(schema.booking).where(eq(schema.booking.id, res.booking.id));
    assert.equal(row?.calendarSync, "synced");
    assert.ok(eventOf(res.booking.id));
  });

  it("puts the Meet link in reminders", async () => {
    const res = await book(consult, at("12:00", "2030-01-09"));
    assert.ok(res.ok);
    await db
      .update(schema.booking)
      .set({ updatedAt: new Date(0) })
      .where(eq(schema.booking.id, res.booking.id));
    const reminders = createBookingReminders({
      db,
      calendar,
      outbox: { add: async () => {} } as never,
      outboxJobOptions: {},
    });
    await reminders.sweep(new Date(res.booking.startsAt.getTime() - 2 * 3_600_000 + 60_000));
    const [sent] = await db
      .select()
      .from(schema.bookingReminder)
      .where(eq(schema.bookingReminder.bookingId, res.booking.id));
    const [msg] = await db
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, sent?.messageId ?? ""));
    assert.match(
      (msg?.content as { body?: string } | undefined)?.body ?? "",
      /Join online: https:\/\/meet\.google\.com\//,
    );
  });

  it("asks to reconnect when Google revokes access, and keeps taking bookings", async () => {
    google.state.refreshTokens.clear();
    await db
      .update(schema.calendarConnection)
      .set({ accessToken: null })
      .where(eq(schema.calendarConnection.branchId, ids.branch));
    const res = await book(haircut, at("10:00", "2030-01-10"));
    assert.ok(res.ok);
    const [conn] = await db
      .select()
      .from(schema.calendarConnection)
      .where(eq(schema.calendarConnection.branchId, ids.branch));
    assert.equal(conn?.status, "needs_reconnect");
    assert.match(conn?.lastError ?? "", /Connect it again/);
  });
});
