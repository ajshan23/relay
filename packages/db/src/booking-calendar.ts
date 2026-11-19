import { decryptSecret, encryptSecret } from "@relay/core";
import { activeBookingStatuses, type Busy, bookingTimeLabel } from "@relay/core/bookings";
import {
  deleteGoogleEvent,
  type GoogleConfig,
  GoogleError,
  type GoogleEventInput,
  getGoogleEvent,
  googleConfig,
  googleEventIdFor,
  googleFreeBusy,
  insertGoogleEvent,
  patchGoogleEvent,
  refreshGoogleToken,
} from "@relay/core/google-calendar";
import { and, eq, gt, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import type { createDb } from "./client";
import { booking, branch, calendarConnection, catalogVariant, contact } from "./schema";

/*
 * A branch's Google Calendar, shared by the API and the worker: tokens kept fresh, busy times read
 * (they close those times for booking), and each booking mirrored as an event (with a Meet link for
 * online services). Relay stays the source of truth: when Google fails, bookings still work and the
 * minute sweep tries the calendar again.
 */

type Db = ReturnType<typeof createDb>["db"];

export type CalendarDeps = {
  google: GoogleConfig;
  /** CHANNEL_SECRET_KEY: the tokens are stored encrypted with it. */
  secretKey: string;
  /** The web app's address, for the link to the chat in the event. */
  appUrl: string;
};

export type ConnectionRow = typeof calendarConnection.$inferSelect;

export async function calendarConnectionOf(db: Db, organizationId: string, branchId: string) {
  const [c] = await db
    .select()
    .from(calendarConnection)
    .where(
      and(eq(calendarConnection.organizationId, organizationId), eq(calendarConnection.branchId, branchId)),
    )
    .limit(1);
  return c ?? null;
}

/** A working access token (refreshed and saved when close to expiring), or null when Google refused. */
export async function accessTokenFor(
  db: Db,
  deps: CalendarDeps,
  conn: ConnectionRow,
): Promise<string | null> {
  if (conn.status === "needs_reconnect") return null;
  const soon = Date.now() + 2 * 60_000;
  if (conn.accessToken && conn.accessExpiresAt && conn.accessExpiresAt.getTime() > soon)
    return decryptSecret(conn.accessToken, deps.secretKey);
  try {
    const fresh = await refreshGoogleToken(deps.google, decryptSecret(conn.refreshToken, deps.secretKey));
    await db
      .update(calendarConnection)
      .set({
        accessToken: encryptSecret(fresh.accessToken, deps.secretKey),
        accessExpiresAt: fresh.expiresAt,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(calendarConnection.id, conn.id));
    return fresh.accessToken;
  } catch (err) {
    if (err instanceof GoogleError && (err.kind === "invalid_grant" || err.kind === "auth")) {
      await db
        .update(calendarConnection)
        .set({
          status: "needs_reconnect",
          lastError: "Google no longer lets Relay use this calendar. Connect it again.",
          updatedAt: new Date(),
        })
        .where(eq(calendarConnection.id, conn.id));
      return null;
    }
    throw err;
  }
}

const busyCache = new Map<string, { at: number; busy: Busy[] }>();

/**
 * Busy times in the branch's Google Calendar between two instants (none when it isn't connected).
 * Cached for a minute; a failure gives none (Relay's own book still works) and is logged.
 */
export async function googleBusy(
  db: Db,
  deps: CalendarDeps | null | undefined,
  q: { organizationId: string; branchId: string; from: Date; to: Date },
): Promise<Busy[]> {
  if (!deps) return [];
  const conn = await calendarConnectionOf(db, q.organizationId, q.branchId);
  if (conn?.status !== "active" || !conn.calendarId) return [];
  const hour = 3_600_000;
  const from = new Date(Math.floor(q.from.getTime() / hour) * hour);
  const to = new Date(Math.ceil(q.to.getTime() / hour) * hour);
  const key = `${conn.id}:${conn.calendarId}:${from.toISOString()}:${to.toISOString()}`;
  const hit = busyCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.busy;
  try {
    const token = await accessTokenFor(db, deps, conn);
    if (!token) return [];
    const busy = await googleFreeBusy(deps.google, token, conn.calendarId, from, to);
    if (busyCache.size > 500) busyCache.clear();
    busyCache.set(key, { at: Date.now(), busy });
    return busy;
  } catch (err) {
    console.warn(`[calendar] busy times for ${q.branchId} not read: ${(err as Error).message}`);
    return [];
  }
}

/** Forget cached busy times (after connecting, or in tests). */
export function forgetGoogleBusy() {
  busyCache.clear();
}

export type SyncResult = { status: "synced" | "failed" | "skipped"; meetUrl: string | null; error?: string };

/**
 * Makes the booking's Google event match it: added (with a Meet link for online services), moved, or
 * deleted when cancelled. Records the outcome on the booking; never throws.
 */
export async function syncBooking(
  db: Db,
  deps: CalendarDeps | null | undefined,
  bookingId: string,
): Promise<SyncResult> {
  const [row] = await db
    .select({
      b: booking,
      online: catalogVariant.bookingOnline,
      contactName: contact.name,
      contactPhone: contact.phone,
      timezone: branch.timezone,
    })
    .from(booking)
    .leftJoin(catalogVariant, eq(catalogVariant.id, booking.variantId))
    .leftJoin(contact, eq(contact.id, booking.contactId))
    .innerJoin(branch, eq(branch.id, booking.branchId))
    .where(eq(booking.id, bookingId))
    .limit(1);
  if (!row) return { status: "skipped", meetUrl: null };
  const b = row.b;
  if (!deps) return { status: "skipped", meetUrl: b.meetUrl };
  const conn = await calendarConnectionOf(db, b.organizationId, b.branchId);
  if (conn?.status !== "active" || !conn.calendarId) return { status: "skipped", meetUrl: b.meetUrl };
  const calendarId = conn.calendarId;
  const record = async (set: Partial<typeof booking.$inferInsert>) => {
    await db
      .update(booking)
      .set({ ...set, calendarTriedAt: new Date() })
      .where(eq(booking.id, b.id));
  };
  try {
    const token = await accessTokenFor(db, deps, conn);
    if (!token) throw new Error("Google needs connecting again.");
    if (!activeBookingStatuses.includes(b.status)) {
      // Cancelled (or a no-show): a cancelled booking leaves the calendar; a no-show stays as history.
      if (b.status === "cancelled" && b.externalEventId)
        await deleteGoogleEvent(deps.google, token, calendarId, b.externalEventId);
      await record({ calendarSync: "synced", calendarError: null, calendarAttempts: 0 });
      return { status: "synced", meetUrl: b.meetUrl };
    }
    const tz = row.timezone || "UTC";
    const who =
      row.contactName?.trim() || (row.contactPhone ? `+${row.contactPhone.replace(/^\+/, "")}` : "Customer");
    const input: GoogleEventInput = {
      summary: `${b.title} · ${who}`,
      description: [
        `Booked in Relay${b.bookedBy === "ai" ? " by the AI agent" : ""} for ${bookingTimeLabel(b.startsAt, tz)}.`,
        `Customer: ${who}${row.contactPhone ? ` (+${row.contactPhone.replace(/^\+/, "")})` : ""}`,
        `Reference: ${b.reference}`,
        b.partySize ? `People: ${b.partySize}` : "",
        b.notes ? `Notes: ${b.notes}` : "",
        b.conversationId
          ? `Chat: ${deps.appUrl.replace(/\/$/, "")}/conversations?view=all&c=${b.conversationId}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      start: b.startsAt,
      end: b.endsAt,
      timeZone: tz,
    };
    const eventId = b.externalEventId ?? googleEventIdFor(b.id);
    let ev = null as Awaited<ReturnType<typeof insertGoogleEvent>> | null;
    if (b.externalEventId) {
      ev = await patchGoogleEvent(deps.google, token, calendarId, eventId, input).catch(async (err) => {
        // Deleted in Google by hand: add it again.
        if (err instanceof GoogleError && err.kind === "not_found") return null;
        throw err;
      });
    }
    if (!ev) {
      try {
        ev = await insertGoogleEvent(deps.google, token, calendarId, input, {
          eventId,
          ...(row.online ? { meetRequestId: b.id } : {}),
        });
      } catch (err) {
        // Added on an earlier try that didn't get recorded: make that one match instead.
        if (err instanceof GoogleError && err.status === 409)
          ev = await patchGoogleEvent(deps.google, token, calendarId, eventId, input);
        else throw err;
      }
    }
    // A Meet link can take a moment: read the event again a few times.
    for (let i = 0; row.online && ev.meetStatus === "pending" && i < 4; i++) {
      await new Promise((r) => setTimeout(r, deps.google.backoffMs ?? 1500));
      ev = await getGoogleEvent(deps.google, token, calendarId, ev.id);
    }
    const meetUrl = ev.meetUrl ?? b.meetUrl;
    await record({
      externalEventId: ev.id,
      meetUrl,
      calendarSync: row.online && !meetUrl ? "failed" : "synced",
      calendarError: row.online && !meetUrl ? "Google hasn't made the Meet link yet." : null,
      calendarAttempts: row.online && !meetUrl ? b.calendarAttempts + 1 : 0,
    });
    return { status: "synced", meetUrl };
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    await record({ calendarSync: "failed", calendarError: error, calendarAttempts: b.calendarAttempts + 1 });
    return { status: "failed", meetUrl: b.meetUrl, error };
  }
}

/** Tries the calendar again for bookings Google hasn't got right yet (each a few times, spaced out). */
export async function retryCalendarSyncs(db: Db, deps: CalendarDeps | null | undefined, now = new Date()) {
  if (!deps) return 0;
  const rows = await db
    .select({ id: booking.id, attempts: booking.calendarAttempts, triedAt: booking.calendarTriedAt })
    .from(booking)
    .innerJoin(
      calendarConnection,
      and(eq(calendarConnection.branchId, booking.branchId), eq(calendarConnection.status, "active")),
    )
    .where(
      and(
        ne(booking.calendarSync, "synced"),
        lt(booking.calendarAttempts, 5),
        or(
          and(inArray(booking.status, activeBookingStatuses), gt(booking.endsAt, now)),
          and(eq(booking.status, "cancelled"), isNotNull(booking.externalEventId)),
        ),
      ),
    )
    .orderBy(booking.startsAt)
    .limit(100);
  let done = 0;
  for (const r of rows) {
    // 1, 2, 4, 8 minutes apart.
    if (r.triedAt && now.getTime() - r.triedAt.getTime() < 60_000 * 2 ** Math.max(0, r.attempts - 1))
      continue;
    await syncBooking(db, deps, r.id);
    done++;
  }
  return done;
}

/** The calendar setup for this server: null when Google or the encryption key isn't configured. */
export function calendarDepsFrom(
  env: {
    GOOGLE_CLIENT_ID?: string | undefined;
    GOOGLE_CLIENT_SECRET?: string | undefined;
    GOOGLE_OAUTH_BASE_URL?: string | undefined;
    GOOGLE_API_BASE_URL?: string | undefined;
    CHANNEL_SECRET_KEY?: string | undefined;
    WEB_URL: string;
  },
  extra: Partial<Pick<GoogleConfig, "fetch" | "backoffMs">> = {},
): CalendarDeps | null {
  const google = googleConfig(env);
  if (!google || !env.CHANNEL_SECRET_KEY) return null;
  return { google: { ...google, ...extra }, secretKey: env.CHANNEL_SECRET_KEY, appUrl: env.WEB_URL };
}
