import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { newId } from "@relay/core";
import { defaultBookingSettings, zonedTime } from "@relay/core/bookings";
import {
  createBooking,
  createCatalogType,
  createDb,
  eq,
  findTimes,
  moveBooking,
  saveBookingSettings,
  saveCatalogItem,
  schema,
  setBookingStatus,
} from "@relay/db";
import { createBookingReminders } from "../src/bookings/reminders";

/*
 * Relay's booking book on the local drill database: places are never given twice (even at the same
 * moment), only offered times can be booked by the agent, moving and cancelling free the place, and
 * reminders go out once each, at the right time, as buttons or the approved template.
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const T = `b${Date.now().toString(36)}`;
const ids = { org: `org_${T}`, branch: `br_${T}`, channel: `ch_${T}`, contact: `ct_${T}`, conv: `conv_${T}` };
const tz = "Asia/Dubai";
const day = "2030-01-08"; // a Tuesday
const at = (hhmm: string, date = day) =>
  zonedTime(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), tz);
// The day before, early: everything that day is bookable (no notice problems).
const now = at("06:00", "2030-01-07");
let single = "";
let tables = "";
const queued: string[] = [];

const book = (variantId: string, start: Date, extra: Partial<Parameters<typeof createBooking>[1]> = {}) =>
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
    ...extra,
  });

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: ids.org, name: "Lumen Booking Test", slug: `lumen-${T}`, createdAt: new Date() });
  await db
    .insert(schema.branch)
    .values({ id: ids.branch, organizationId: ids.org, name: "Marina", slug: `marina-${T}`, timezone: tz });
  await db.insert(schema.channelAccount).values({
    id: ids.channel,
    organizationId: ids.org,
    type: "whatsapp",
    provider: "meta",
    externalId: `pn_${T}`,
    displayName: "Lumen booking test",
    credentials: "test",
    status: "active",
    branchId: ids.branch,
  });
  await db.insert(schema.contact).values({
    id: ids.contact,
    organizationId: ids.org,
    branchId: ids.branch,
    name: "Asha",
    phone: "971500000001",
  });
  await db.insert(schema.contactIdentity).values({
    id: `cid_${T}`,
    organizationId: ids.org,
    contactId: ids.contact,
    branchId: ids.branch,
    channelType: "whatsapp",
    scope: "waba",
    externalId: "971500000001",
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
    windowExpiresAt: new Date(now.getTime() + 3 * 86_400_000),
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
  for (const [title, capacity] of [
    ["Haircut", 1],
    ["Table", 2],
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
            bookingCapacity: capacity,
          },
        ],
      },
      newId: (k) => newId(k),
    });
    const [v] = await db
      .select()
      .from(schema.catalogVariant)
      .where(eq(schema.catalogVariant.itemId, item.id));
    if (title === "Haircut") single = v?.id ?? "";
    else tables = v?.id ?? "";
  }
  await saveBookingSettings(db, ids.org, ids.branch, {
    ...defaultBookingSettings,
    enabled: true,
    hours: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, from: "09:00", to: "18:00" })),
    minNoticeMinutes: 0,
  });
});

after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, ids.org));
  await pg.end();
});

describe("booking a place", () => {
  it("never gives the last place twice, even at the same moment", async () => {
    const [a, b] = await Promise.all([book(single, at("10:00")), book(single, at("10:00"))]);
    assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
    const failed = [a, b].find((x) => !x.ok);
    assert.equal(failed && !failed.ok && failed.reason, "taken");
    // Two tables: two fit, the third doesn't.
    const three = await Promise.all([
      book(tables, at("12:00")),
      book(tables, at("12:00")),
      book(tables, at("12:00")),
    ]);
    assert.equal(three.filter((x) => x.ok).length, 2);
    const free = await findTimes(db, {
      organizationId: ids.org,
      branchId: ids.branch,
      variantId: single,
      from: at("09:00"),
      to: at("11:00"),
      now,
    });
    assert.ok(free.ok);
    assert.deepEqual(
      free.times.map((t) => t.toISOString()),
      [at("09:00"), at("09:30"), at("10:30")].map((t) => t.toISOString()),
      "10:00 is taken",
    );
  });

  it("books only offered times for the agent; the team may book any time", async () => {
    const off = await book(single, at("20:00"));
    assert.equal(!off.ok && off.reason, "not_offered");
    const team = await book(single, at("20:00"), { bookedBy: "team", anyTime: true });
    assert.ok(team.ok);
    assert.match(team.label, /Tue 8 Jan, 8:00 pm/);
    assert.match(team.booking.reference, /^[A-Z2-9]{6}$/);
  });

  it("frees the place when a booking is moved or cancelled", async () => {
    const first = await book(single, at("14:00"));
    assert.ok(first.ok);
    assert.equal((await book(single, at("14:00"))).ok, false);
    const moved = await moveBooking(db, {
      organizationId: ids.org,
      bookingId: first.booking.id,
      startsAt: at("15:00"),
      now,
    });
    assert.ok(moved.ok);
    assert.ok((await book(single, at("14:00"))).ok, "14:00 is free again");
    await setBookingStatus(db, { organizationId: ids.org, bookingId: first.booking.id, status: "cancelled" });
    assert.ok((await book(single, at("15:00"))).ok, "15:00 is free again");
  });
});

describe("reminders", () => {
  const reminders = createBookingReminders({
    db,
    outbox: { add: async (_: string, d: { messageId: string }) => queued.push(d.messageId) } as never,
    outboxJobOptions: {},
  });
  const sentFor = async (bookingId: string) =>
    db.select().from(schema.bookingReminder).where(eq(schema.bookingReminder.bookingId, bookingId));

  it("sends each reminder once, at its time, with Confirm and Change", async () => {
    const res = await book(single, at("16:00"));
    assert.ok(res.ok);
    const id = res.booking.id;
    const start = res.booking.startsAt.getTime();
    // Too early for both.
    await reminders.sweep(new Date(start - 25 * 3_600_000));
    assert.equal((await sentFor(id)).length, 0);
    // The day before: one reminder, as buttons (the chat is open).
    await reminders.sweep(new Date(start - 24 * 3_600_000 + 60_000));
    await reminders.sweep(new Date(start - 24 * 3_600_000 + 120_000));
    const once = await sentFor(id);
    assert.equal(once.length, 1);
    assert.equal(once[0]?.outcome, "sent");
    const [msg] = await db
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, once[0]?.messageId ?? ""));
    const content = msg?.content as {
      body: string;
      options: { id: string; title: string }[];
      booking: { reference: string };
    };
    assert.match(content.body, /a reminder of your Haircut on Tue 8 Jan, 4:00 pm/);
    assert.deepEqual(
      content.options.map((o) => o.title),
      ["Confirm", "Change"],
    );
    assert.equal(content.options[0]?.id, `bk_${id}_confirm`);
    assert.ok(queued.includes(msg?.id ?? ""));
    // Two hours before: the second.
    await reminders.sweep(new Date(start - 2 * 3_600_000 + 60_000));
    assert.equal((await sentFor(id)).length, 2);

    // Moved to another day: fresh reminders for the new time.
    const moved = await moveBooking(db, {
      organizationId: ids.org,
      bookingId: id,
      startsAt: at("16:00", "2030-01-09"),
      now,
    });
    assert.ok(moved.ok);
    await db
      .update(schema.booking)
      .set({ updatedAt: new Date(start - 30 * 3_600_000) })
      .where(eq(schema.booking.id, id));
    await reminders.sweep(new Date(moved.booking.startsAt.getTime() - 24 * 3_600_000 + 60_000));
    assert.equal((await sentFor(id)).length, 3);
  });

  it("skips a reminder whose time had passed when booked, and uses the template outside the window", async () => {
    const late = await book(tables, at("17:00"));
    assert.ok(late.ok);
    const start = late.booking.startsAt.getTime();
    // Booked 3 hours before: the day-before reminder is skipped silently, the 2-hour one goes.
    await db
      .update(schema.booking)
      .set({ updatedAt: new Date(start - 3 * 3_600_000) })
      .where(eq(schema.booking.id, late.booking.id));
    await reminders.sweep(new Date(start - 2 * 3_600_000 + 60_000));
    assert.deepEqual(
      (await sentFor(late.booking.id)).map((r) => r.hoursBefore),
      [2],
    );

    // The chat is closed: no template chosen → skipped with the reason; with an approved one → sent.
    await db
      .update(schema.conversation)
      .set({ windowExpiresAt: new Date(0) })
      .where(eq(schema.conversation.id, ids.conv));
    const other = await book(tables, at("09:00", "2030-01-10"));
    assert.ok(other.ok);
    const s2 = other.booking.startsAt.getTime();
    await db
      .update(schema.booking)
      .set({ updatedAt: new Date(s2 - 48 * 3_600_000) })
      .where(eq(schema.booking.id, other.booking.id));
    await reminders.sweep(new Date(s2 - 24 * 3_600_000 + 60_000));
    const [skipped] = await sentFor(other.booking.id);
    assert.equal(skipped?.outcome, "skipped");
    assert.match(skipped?.note ?? "", /no reminder template is chosen/);

    const templateId = `tpl_${T}`;
    await db.insert(schema.messageTemplate).values({
      id: templateId,
      organizationId: ids.org,
      name: "Booking reminder",
      slug: "booking_reminder",
      language: "en",
      purpose: "updates",
      content: {
        header: null,
        body: "Hi {{customer_name}}, your {{service}} is on {{date}} at {{time}} ({{reference}}).",
        footer: null,
        buttons: [
          { kind: "reply", text: "Confirm" },
          { kind: "reply", text: "Change" },
        ],
      },
    });
    await db.insert(schema.templateChannel).values({
      id: `tch_${T}`,
      organizationId: ids.org,
      templateId,
      channelAccountId: ids.channel,
      scope: "waba",
      status: "ready",
    });
    await saveBookingSettings(db, ids.org, ids.branch, {
      ...defaultBookingSettings,
      enabled: true,
      hours: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, from: "09:00", to: "18:00" })),
      minNoticeMinutes: 0,
      reminderTemplateId: templateId,
    });
    await reminders.sweep(new Date(s2 - 2 * 3_600_000 + 60_000));
    const sent = (await sentFor(other.booking.id)).find((r) => r.hoursBefore === 2);
    assert.equal(sent?.outcome, "sent");
    const [msg] = await db
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, sent?.messageId ?? ""));
    assert.equal(msg?.type, "template");
    const c = msg?.content as {
      values: Record<string, string>;
      quickReplyPayloads: { index: number; payload: string }[];
    };
    assert.equal(c.values.service, "Table");
    assert.equal(c.values.date, "Thursday 10 January");
    assert.equal(c.values.time, "9:00 am");
    assert.deepEqual(
      c.quickReplyPayloads.map((p) => p.payload),
      [`bk_${other.booking.id}_confirm`, `bk_${other.booking.id}_change`],
    );
  });
});
