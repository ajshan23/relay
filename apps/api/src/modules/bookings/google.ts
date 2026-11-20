import { decryptSecret, decryptSecretJson, encryptSecret, newId } from "@relay/core";
import {
  exchangeGoogleCode,
  googleAuthUrl,
  listOwnedCalendars,
  revokeGoogleToken,
} from "@relay/core/google-calendar";
import {
  accessTokenFor,
  and,
  calendarConnectionOf,
  calendarDepsFrom,
  eq,
  forgetGoogleBusy,
  gt,
  inArray,
  schema,
} from "@relay/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { branchAccess, can, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import type { BranchEnv } from "../contacts/shared";

/*
 * Connecting a branch's Google Calendar:
 *   GET    /api/bookings/google            the connection (no tokens) and whether Google is set up
 *   POST   /api/bookings/google/connect    (managers) Google's consent address to open
 *   GET    /api/bookings/google/callback   Google sends the manager back here (googleCallbackRoutes)
 *   PUT    /api/bookings/google            (managers) { calendarId }: which of their calendars
 *   POST   /api/bookings/google/calendars  (managers) read their calendars again
 *   DELETE /api/bookings/google            (managers) disconnect (the token is revoked)
 *
 * The OAuth state is encrypted (organisation, branch, user, expiry), so it can't be forged, and it
 * only works for the manager who started it, for 10 minutes.
 */

type State = { o: string; b: string; u: string; e: number; n: string };
const STATE_MS = 10 * 60_000;

const C = schema.calendarConnection;

/** Upcoming bookings go (again) into the chosen calendar. */
async function resyncUpcoming(
  ctx: AppContext,
  organizationId: string,
  branchId: string,
  clearEvents: boolean,
) {
  await ctx.db
    .update(schema.booking)
    .set({
      calendarSync: "pending",
      calendarAttempts: 0,
      calendarTriedAt: null,
      ...(clearEvents ? { externalEventId: null } : {}),
    })
    .where(
      and(
        eq(schema.booking.organizationId, organizationId),
        eq(schema.booking.branchId, branchId),
        inArray(schema.booking.status, ["booked", "confirmed"]),
        gt(schema.booking.endsAt, new Date()),
      ),
    );
}

export function registerGoogleRoutes(app: Hono<BranchEnv>, ctx: AppContext) {
  const deps = calendarDepsFrom(ctx.config);
  const canManage = async (c: Context<BranchEnv>) =>
    can(c.var.access, "bookings.settings", { branchId: c.var.branchId });

  const shown = (conn: typeof C.$inferSelect | null) =>
    conn
      ? {
          accountEmail: conn.accountEmail,
          calendarId: conn.calendarId,
          calendarName: conn.calendarName,
          calendars: conn.calendars,
          status: conn.status,
          lastError: conn.lastError,
          updatedAt: conn.updatedAt,
        }
      : null;

  app.get("/google", async (c) => {
    const conn = await calendarConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId);
    return c.json({ configured: !!deps, connection: shown(conn), canManage: await canManage(c) });
  });

  app.post("/google/connect", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    if (!deps) return fail(c, 422, "not_configured", "Google isn't set up on this server yet.");
    const state: State = {
      o: c.var.access.orgId,
      b: c.var.branchId,
      u: c.var.access.userId,
      e: Date.now() + STATE_MS,
      n: newId("calendarConnection"),
    };
    return c.json({ url: googleAuthUrl(deps.google, encryptSecret(state, deps.secretKey)) });
  });

  app.put("/google", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, z.object({ calendarId: z.string().min(1).max(500) }));
    if ("error" in parsed) return parsed.error;
    const conn = await calendarConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId);
    if (!conn) return fail(c, 404, "not_found", "Connect Google Calendar first.");
    const cal = conn.calendars.find((x) => x.id === parsed.data.calendarId);
    if (!cal) return fail(c, 422, "invalid_input", "That isn't one of your calendars.");
    const changed = conn.calendarId !== cal.id;
    await ctx.db
      .update(C)
      .set({
        calendarId: cal.id,
        calendarName: cal.name,
        status: conn.status === "needs_reconnect" ? "needs_reconnect" : "active",
        updatedAt: new Date(),
      })
      .where(eq(C.id, conn.id));
    forgetGoogleBusy();
    if (changed) await resyncUpcoming(ctx, conn.organizationId, conn.branchId, true);
    return c.json({
      connection: shown(await calendarConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId)),
    });
  });

  app.post("/google/calendars", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    if (!deps) return fail(c, 422, "not_configured", "Google isn't set up on this server yet.");
    const conn = await calendarConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId);
    if (!conn) return fail(c, 404, "not_found", "Connect Google Calendar first.");
    const token = await accessTokenFor(ctx.db, deps, conn);
    if (!token) return fail(c, 409, "needs_reconnect", "Google needs connecting again.");
    const calendars = await listOwnedCalendars(deps.google, token);
    await ctx.db.update(C).set({ calendars, updatedAt: new Date() }).where(eq(C.id, conn.id));
    return c.json({
      connection: shown(await calendarConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId)),
    });
  });

  app.delete("/google", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const conn = await calendarConnectionOf(ctx.db, c.var.access.orgId, c.var.branchId);
    if (!conn) return c.json({ ok: true });
    if (deps) await revokeGoogleToken(deps.google, decryptSecret(conn.refreshToken, deps.secretKey));
    await ctx.db.delete(C).where(eq(C.id, conn.id));
    forgetGoogleBusy();
    return c.json({ ok: true });
  });
}

/** Where Google sends the manager back. No ?branch=: the state says which branch. */
export function googleCallbackRoutes(ctx: AppContext) {
  const app = new Hono();
  const deps = calendarDepsFrom(ctx.config);
  const back = (c: Context, outcome: string) =>
    c.redirect(`${ctx.config.WEB_URL.replace(/\/$/, "")}/agents?view=booking-settings&google=${outcome}`);
  app.use(requireSession, requireOrg(ctx));
  app.get("/", async (c) => {
    if (!deps) return back(c, "not_configured");
    if (c.req.query("error")) return back(c, "cancelled");
    let state: State;
    try {
      state = decryptSecretJson<State>(c.req.query("state") ?? "", deps.secretKey);
    } catch {
      return back(c, "expired");
    }
    const access = (c as unknown as Context<BranchEnv>).var.access;
    if (state.e < Date.now() || state.u !== access.userId || state.o !== access.orgId)
      return back(c, "expired");
    if (
      !(await branchAccess(ctx, access, state.b)) ||
      !can(access, "bookings.settings", { branchId: state.b })
    )
      return back(c, "forbidden");
    try {
      const tokens = await exchangeGoogleCode(deps.google, c.req.query("code") ?? "");
      if (!tokens.refreshToken) return back(c, "no_offline_access");
      const calendars = await listOwnedCalendars(deps.google, tokens.accessToken);
      const primary = calendars.find((x) => x.primary) ?? calendars[0];
      const values = {
        organizationId: state.o,
        branchId: state.b,
        provider: "google" as const,
        accountEmail: tokens.email,
        refreshToken: encryptSecret(tokens.refreshToken, deps.secretKey),
        accessToken: encryptSecret(tokens.accessToken, deps.secretKey),
        accessExpiresAt: tokens.expiresAt,
        calendars,
        calendarId: primary?.id ?? null,
        calendarName: primary?.name ?? null,
        status: primary ? ("active" as const) : ("pick_calendar" as const),
        lastError: null,
        connectedByUserId: access.userId,
        updatedAt: new Date(),
      };
      const before = await calendarConnectionOf(ctx.db, state.o, state.b);
      await ctx.db
        .insert(C)
        .values({ id: newId("calendarConnection"), ...values })
        .onConflictDoUpdate({ target: C.branchId, set: values });
      forgetGoogleBusy();
      await resyncUpcoming(ctx, state.o, state.b, before?.calendarId !== values.calendarId);
      return back(c, primary ? "connected" : "no_calendars");
    } catch (err) {
      console.warn("[calendar] Google connect failed:", (err as Error).message);
      return back(c, "failed");
    }
  });
  return app;
}
