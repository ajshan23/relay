import type { GoogleConfig } from "../src/google-calendar";

/*
 * A pretend Google (OAuth token endpoint + Calendar API) as a fetch function, for tests: tokens,
 * calendars, busy times, events, and Meet links that start "pending" and appear on the next read.
 */

export type FakeEvent = {
  id: string;
  calendarId: string;
  body: Record<string, unknown>;
  meetRequestId: string | null;
  meetReads: number;
  deleted: boolean;
  /** sendUpdates of every add, change and delete ("all" emails the guests, "none" nobody). */
  sendUpdates: string[];
};

export type FakeTask = {
  id: string;
  listId: string;
  title: string;
  notes: string;
  due: string | null;
  status: "needsAction" | "completed";
  deleted: boolean;
};

export function createFakeGoogle() {
  const state = {
    taskLists: [{ id: "list-my", title: "My Tasks" }] as { id: string; title: string }[],
    tasks: [] as FakeTask[],
    tokens: new Set<string>(),
    refreshTokens: new Set<string>(["rt-1"]),
    busy: [] as { start: string; end: string }[],
    events: [] as FakeEvent[],
    /** Answer the next N calls with 503. */
    failNext: 0,
    /** Every call fails to connect. */
    down: false,
    calls: [] as string[],
    /** The scopes Google says it granted (people can untick one on the consent screen). */
    grantScope: "calendar",
    seq: 0,
  };
  const reply = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const idToken = (email: string) =>
    `x.${btoa(JSON.stringify({ email })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.y`;
  const newAccess = () => {
    const t = `at-${++state.seq}`;
    state.tokens.add(t);
    return t;
  };
  const meetOf = (e: FakeEvent) =>
    e.meetRequestId
      ? e.meetReads > 0
        ? {
            createRequest: { requestId: e.meetRequestId, status: { statusCode: "success" } },
            entryPoints: [
              { entryPointType: "video", uri: `https://meet.google.com/${e.meetRequestId.slice(-10)}` },
            ],
          }
        : { createRequest: { requestId: e.meetRequestId, status: { statusCode: "pending" } } }
      : undefined;

  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init.method ?? "GET";
    state.calls.push(`${method} ${url.pathname}`);
    if (state.down) throw new TypeError("fetch failed");
    if (state.failNext > 0) {
      state.failNext--;
      return reply(503, { error: "backend error" });
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good-code") return reply(400, { error: "invalid_grant" });
        return reply(200, {
          access_token: newAccess(),
          refresh_token: "rt-1",
          expires_in: 3600,
          id_token: idToken("owner@lumen.test"),
          scope: state.grantScope,
        });
      }
      if (!state.refreshTokens.has(form.get("refresh_token") ?? ""))
        return reply(400, { error: "invalid_grant" });
      return reply(200, { access_token: newAccess(), expires_in: 3600 });
    }
    if (url.pathname === "/revoke") {
      state.refreshTokens.delete(new URLSearchParams(String(init.body)).get("token") ?? "");
      return reply(200, {});
    }
    const auth = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    if (!state.tokens.has(auth)) return reply(401, { error: "unauthorized" });
    if (url.pathname === "/calendar/v3/users/me/calendarList")
      return reply(200, {
        items: [
          {
            id: "owner@lumen.test",
            summary: "Lumen",
            primary: true,
            accessRole: "owner",
            timeZone: "Asia/Dubai",
          },
          { id: "team@group", summary: "Team", accessRole: "owner", timeZone: "Asia/Dubai" },
          { id: "holidays", summary: "Holidays", accessRole: "reader" },
        ],
      });
    if (url.pathname === "/calendar/v3/freeBusy") {
      const body = JSON.parse(String(init.body)) as {
        timeMin: string;
        timeMax: string;
        items: { id: string }[];
      };
      const id = body.items[0]?.id ?? "";
      const busy = state.busy.filter((b) => b.start < body.timeMax && b.end > body.timeMin);
      return reply(200, { calendars: { [id]: { busy } } });
    }
    if (url.pathname === "/tasks/v1/users/@me/lists") {
      if (method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string };
        const l = { id: `list-${++state.seq}`, title: body.title };
        state.taskLists.push(l);
        return reply(200, l);
      }
      return reply(200, { items: state.taskLists });
    }
    const tm = /^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(url.pathname);
    if (tm) {
      const listId = decodeURIComponent(tm[1] as string);
      if (!state.taskLists.some((l) => l.id === listId)) return reply(404, { error: "list not found" });
      if (method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string; notes?: string; due?: string };
        const t: FakeTask = {
          id: `task-${++state.seq}`,
          listId,
          title: body.title,
          notes: body.notes ?? "",
          due: body.due ?? null,
          status: "needsAction",
          deleted: false,
        };
        state.tasks.push(t);
        return reply(200, {
          id: t.id,
          status: t.status,
          webViewLink: `https://tasks.google.com/task/${t.id}`,
        });
      }
      const t = state.tasks.find((x) => x.id === decodeURIComponent(tm[2] ?? "") && x.listId === listId);
      if (!t) return reply(404, { error: "not found" });
      return reply(200, { id: t.id, status: t.status, ...(t.deleted ? { deleted: true } : {}) });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (m) {
      const calendarId = decodeURIComponent(m[1] as string);
      const eventId = m[2] ? decodeURIComponent(m[2]) : null;
      if (method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown> & {
          conferenceData?: { createRequest?: { requestId: string } };
        };
        // Like Google: a chosen id must be base32hex (0-9, a-v), 5 to 1024 characters.
        if (typeof body.id === "string" && !/^[0-9a-v]{5,1024}$/.test(body.id))
          return reply(400, { error: { code: 400, message: "Invalid resource id value." } });
        if (typeof body.id === "string" && state.events.some((x) => x.id === body.id))
          return reply(409, { error: { code: 409, message: "The requested identifier already exists." } });
        const e: FakeEvent = {
          id: typeof body.id === "string" ? body.id : `ev${++state.seq}`,
          calendarId,
          body,
          meetRequestId: body.conferenceData?.createRequest?.requestId ?? null,
          meetReads: 0,
          deleted: false,
          sendUpdates: [url.searchParams.get("sendUpdates") ?? ""],
        };
        state.events.push(e);
        return reply(200, { id: e.id, conferenceData: meetOf(e) });
      }
      const e = state.events.find((x) => x.id === eventId && !x.deleted);
      if (!e) return reply(404, { error: "not found" });
      if (method === "GET") {
        e.meetReads++;
        return reply(200, { id: e.id, conferenceData: meetOf(e) });
      }
      if (method !== "GET") e.sendUpdates.push(url.searchParams.get("sendUpdates") ?? "");
      if (method === "PATCH") {
        e.body = { ...e.body, ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
        return reply(200, { id: e.id, conferenceData: meetOf(e) });
      }
      if (method === "DELETE") {
        e.deleted = true;
        return new Response(null, { status: 204 });
      }
    }
    return reply(404, { error: `no fake for ${method} ${url.pathname}` });
  }) as typeof fetch;

  const config: GoogleConfig = {
    clientId: "cid",
    clientSecret: "secret",
    redirectUri: "http://localhost:3200/api/bookings/google/callback",
    authorizeUrl: "https://fake.google/o/oauth2/v2/auth",
    tokenUrl: "https://fake.google/token",
    revokeUrl: "https://fake.google/revoke",
    apiBase: "https://fake.google",
    fetch: fakeFetch,
    backoffMs: 0,
  };
  return { state, config, fetch: fakeFetch };
}
