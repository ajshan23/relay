import { newId } from "@relay/core";
import {
  bookingSettingsSchema,
  bookingStatuses,
  bookingTimeLabel,
  localTime,
  nextDate,
  zonedTime,
} from "@relay/core/bookings";
import {
  and,
  asc,
  bookableServices,
  bookingProblem,
  bookingSettingsOf,
  calendarDepsFrom,
  cleanGuestEmails,
  createBooking,
  desc,
  eq,
  findTimes,
  gte,
  ilike,
  lt,
  maxBookingGuests,
  moveBooking,
  or,
  saveBookingGuests,
  saveBookingSettings,
  schema,
  setBookingStatus,
  sql,
} from "@relay/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { can, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { type BranchEnv, requireBranch, requirePermission } from "../contacts/shared";
import { registerGoogleRoutes } from "./google";

/*
 * The selected branch's bookings (?branch=), Relay's own booking book:
 *   GET   /api/bookings/settings     settings, bookable services, templates for reminders
 *   PUT   /api/bookings/settings     (managers)
 *   GET   /api/bookings?from&to       bookings in a range (default: today and the next 14 days)
 *   GET   /api/bookings/times?variantId&date   free times on a day
 *   GET   /api/bookings/contacts?q    customers to book for
 *   POST  /api/bookings              the team books a place (any time allowed)
 *   PATCH /api/bookings/:id          { status }, { startsAt } (move) or { guestEmails } (Google invites)
 * Anyone in the branch may see and add bookings; managers change the settings.
 */

const B = schema.booking;

const guestEmails = z.array(z.string().max(254)).max(maxBookingGuests, `At most ${maxBookingGuests} guests.`);

const createBody = z.object({
  variantId: z.string().min(1),
  contactId: z.string().min(1),
  startsAt: z.iso.datetime({ offset: true }),
  partySize: z.number().int().min(1).max(500).nullable().optional(),
  notes: z.string().max(1000).optional(),
  guestEmails: guestEmails.optional(),
});

const patchBody = z.union([
  z.object({ status: z.enum(bookingStatuses) }),
  z.object({ startsAt: z.iso.datetime({ offset: true }) }),
  z.object({ guestEmails }),
]);

const badEmail = "One of the guests isn't an email address.";

export function bookingRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx), requirePermission("bookings.view"));
  // The branch's Google Calendar, when Google is set up on this server.
  const calendar = calendarDepsFrom(ctx.config);
  registerGoogleRoutes(app, ctx);

  /** Booking settings (hours, reminders, calendars). */
  async function canManage(c: Context<BranchEnv>) {
    return can(c.var.access, "bookings.settings", { branchId: c.var.branchId });
  }
  /** Adding, moving and cancelling bookings. */
  const canBook = (c: Context<BranchEnv>) =>
    can(c.var.access, "bookings.manage", { branchId: c.var.branchId });
  const scope = (c: Context<BranchEnv>) => ({ organizationId: c.var.access.orgId, branchId: c.var.branchId });

  app.get("/settings", async (c) => {
    const { organizationId, branchId } = scope(c);
    const settings = await bookingSettingsOf(ctx.db, organizationId, branchId);
    const services = await bookableServices(ctx.db, { organizationId, branchId });
    // Templates that could carry reminders: approved on at least one number.
    const templates = await ctx.db
      .select({
        id: schema.messageTemplate.id,
        name: schema.messageTemplate.name,
        ready: sql<boolean>`bool_or(${schema.templateChannel.status} = 'ready')`,
      })
      .from(schema.messageTemplate)
      .leftJoin(schema.templateChannel, eq(schema.templateChannel.templateId, schema.messageTemplate.id))
      .where(eq(schema.messageTemplate.organizationId, organizationId))
      .groupBy(schema.messageTemplate.id, schema.messageTemplate.name)
      .orderBy(asc(schema.messageTemplate.name));
    const { timezone, ...rest } = settings;
    return c.json({
      settings: rest,
      timezone,
      services,
      templates,
      canManage: await canManage(c),
      canBook: canBook(c),
    });
  });

  app.put("/settings", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, bookingSettingsSchema);
    if ("error" in parsed) return parsed.error;
    const { organizationId, branchId } = scope(c);
    if (parsed.data.reminderTemplateId) {
      const [t] = await ctx.db
        .select({ id: schema.messageTemplate.id })
        .from(schema.messageTemplate)
        .where(
          and(
            eq(schema.messageTemplate.id, parsed.data.reminderTemplateId),
            eq(schema.messageTemplate.organizationId, organizationId),
          ),
        );
      if (!t) return fail(c, 422, "invalid_input", "That template wasn't found.");
    }
    await saveBookingSettings(ctx.db, organizationId, branchId, parsed.data);
    return c.json({ ok: true });
  });

  app.get("/", async (c) => {
    const { organizationId, branchId } = scope(c);
    const { timezone } = await bookingSettingsOf(ctx.db, organizationId, branchId);
    const today = zonedTime(localTime(new Date(), timezone).date, 0, timezone);
    const from = c.req.query("from") ? new Date(c.req.query("from") as string) : today;
    const to = c.req.query("to")
      ? new Date(c.req.query("to") as string)
      : new Date(today.getTime() + 15 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
      return fail(c, 422, "invalid_input", "Use dates like 2026-11-20T00:00:00Z.");
    const rows = await ctx.db
      .select({
        b: B,
        contactName: schema.contact.name,
        contactPhone: schema.contact.phone,
      })
      .from(B)
      .leftJoin(schema.contact, eq(schema.contact.id, B.contactId))
      .where(
        and(
          eq(B.organizationId, organizationId),
          eq(B.branchId, branchId),
          gte(B.startsAt, from),
          lt(B.startsAt, to),
        ),
      )
      .orderBy(asc(B.startsAt))
      .limit(1000);
    return c.json({
      timezone,
      bookings: rows.map((r) => ({
        ...r.b,
        label: bookingTimeLabel(r.b.startsAt, timezone),
        contactName: r.contactName,
        contactPhone: r.contactPhone,
      })),
    });
  });

  app.get("/times", async (c) => {
    const { organizationId, branchId } = scope(c);
    const variantId = c.req.query("variantId") ?? "";
    const date = c.req.query("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(c, 422, "invalid_input", "Pick a day.");
    const { timezone } = await bookingSettingsOf(ctx.db, organizationId, branchId);
    const found = await findTimes(ctx.db, {
      organizationId,
      branchId,
      variantId,
      from: zonedTime(date, 0, timezone),
      to: zonedTime(nextDate(date), 0, timezone),
      now: new Date(),
      calendar,
    });
    if (!found.ok) return c.json({ times: [], problem: bookingProblem[found.reason] });
    return c.json({
      times: found.times.map((t) => ({ startsAt: t.toISOString(), label: bookingTimeLabel(t, timezone) })),
      problem: null,
    });
  });

  app.get("/contacts", async (c) => {
    const { organizationId, branchId } = scope(c);
    const q = (c.req.query("q") ?? "").trim();
    const C = schema.contact;
    const rows = await ctx.db
      .select({ id: C.id, name: C.name, phone: C.phone })
      .from(C)
      .where(
        and(
          eq(C.organizationId, organizationId),
          eq(C.branchId, branchId),
          ...(q ? [or(ilike(C.name, `%${q}%`), ilike(C.phone, `%${q.replace(/\D/g, "") || q}%`))] : []),
        ),
      )
      .orderBy(desc(C.updatedAt))
      .limit(10);
    return c.json({ contacts: rows });
  });

  app.post("/", async (c) => {
    if (!canBook(c)) return fail(c, 403, "forbidden", "You don't have access to add bookings.");
    const parsed = await parseBody(c, createBody);
    if ("error" in parsed) return parsed.error;
    const guests = cleanGuestEmails(parsed.data.guestEmails ?? []);
    if (!guests) return fail(c, 422, "invalid_input", badEmail);
    const { organizationId, branchId } = scope(c);
    const [contact] = await ctx.db
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.id, parsed.data.contactId),
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.branchId, branchId),
        ),
      );
    if (!contact) return fail(c, 422, "invalid_input", "That customer wasn't found.");
    const [conv] = await ctx.db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.contactId, contact.id),
          eq(schema.conversation.branchId, branchId),
          eq(schema.conversation.kind, "direct"),
        ),
      )
      .orderBy(sql`${schema.conversation.lastMessageAt} desc nulls last`)
      .limit(1);
    const res = await createBooking(ctx.db, {
      id: newId("booking"),
      organizationId,
      branchId,
      variantId: parsed.data.variantId,
      startsAt: new Date(parsed.data.startsAt),
      contactId: contact.id,
      conversationId: conv?.id ?? null,
      partySize: parsed.data.partySize ?? null,
      notes: parsed.data.notes ?? "",
      bookedBy: "team",
      userId: c.var.access.userId,
      now: new Date(),
      anyTime: true,
      calendar,
    });
    if (!res.ok) return fail(c, 409, res.reason, bookingProblem[res.reason]);
    const invited = guests.length
      ? await saveBookingGuests(ctx.db, {
          organizationId,
          bookingId: res.booking.id,
          guestEmails: guests,
          calendar,
        })
      : null;
    return c.json(
      {
        booking: invited?.booking ?? res.booking,
        label: res.label,
        meetUrl: invited?.sync.meetUrl ?? res.meetUrl,
      },
      201,
    );
  });

  app.patch("/:id", async (c) => {
    if (!canBook(c)) return fail(c, 403, "forbidden", "You don't have access to change bookings.");
    const parsed = await parseBody(c, patchBody);
    if ("error" in parsed) return parsed.error;
    const { organizationId, branchId } = scope(c);
    const [b] = await ctx.db
      .select({ id: B.id })
      .from(B)
      .where(
        and(eq(B.id, c.req.param("id")), eq(B.organizationId, organizationId), eq(B.branchId, branchId)),
      );
    if (!b) return fail(c, 404, "not_found");
    if ("status" in parsed.data) {
      const row = await setBookingStatus(ctx.db, {
        organizationId,
        bookingId: b.id,
        status: parsed.data.status,
        calendar,
      });
      return c.json({ booking: row });
    }
    if ("guestEmails" in parsed.data) {
      const guests = cleanGuestEmails(parsed.data.guestEmails);
      if (!guests) return fail(c, 422, "invalid_input", badEmail);
      const res = await saveBookingGuests(ctx.db, {
        organizationId,
        bookingId: b.id,
        guestEmails: guests,
        calendar,
      });
      if (!res) return fail(c, 409, "not_active", "A cancelled or no-show booking can't take guests.");
      return c.json({ booking: res.booking, calendar: res.sync.status });
    }
    const res = await moveBooking(ctx.db, {
      organizationId,
      bookingId: b.id,
      startsAt: new Date(parsed.data.startsAt),
      now: new Date(),
      anyTime: true,
      calendar,
    });
    if (!res.ok) return fail(c, 409, res.reason, bookingProblem[res.reason]);
    return c.json({ booking: res.booking, label: res.label });
  });

  return app;
}
