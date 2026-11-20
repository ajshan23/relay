/*
 * A small Google Calendar client: connecting (OAuth with a refresh token), the business's own
 * calendars, busy times, and the events for bookings (with a Google Meet link for online services).
 * Plain fetch, injectable for tests; the addresses can point at a fake server in development.
 *
 * Scopes are the narrowest that work: pick a calendar, read busy times, and change events on
 * calendars the business owns.
 */

export const googleCalendarScopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
];

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiBase: string;
  fetch?: typeof fetch;
  /** Pause between retries (tests pass 0). */
  backoffMs?: number;
};

/** The client for this server, or null when Google isn't set up. */
export function googleConfig(env: {
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GOOGLE_OAUTH_BASE_URL?: string | undefined;
  GOOGLE_API_BASE_URL?: string | undefined;
  WEB_URL: string;
}): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const oauth = env.GOOGLE_OAUTH_BASE_URL?.replace(/\/$/, "");
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.WEB_URL.replace(/\/$/, "")}/api/bookings/google/callback`,
    authorizeUrl: oauth ? `${oauth}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: oauth ? `${oauth}/token` : "https://oauth2.googleapis.com/token",
    revokeUrl: oauth ? `${oauth}/revoke` : "https://oauth2.googleapis.com/revoke",
    apiBase: env.GOOGLE_API_BASE_URL?.replace(/\/$/, "") ?? "https://www.googleapis.com",
  };
}

export type GoogleErrorKind = "invalid_grant" | "quota" | "not_found" | "auth" | "other";

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly kind: GoogleErrorKind,
    readonly status: number | null,
  ) {
    super(message);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(cfg: GoogleConfig, url: string, init: RequestInit, tries = 3): Promise<Response> {
  const f = cfg.fetch ?? fetch;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      if (attempt < tries) {
        await wait((cfg.backoffMs ?? 500) * attempt);
        continue;
      }
      throw new GoogleError(`Couldn't reach Google (${(err as Error).message}).`, "other", null);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const quota = res.status === 429 || (res.status === 403 && /rateLimit|quota|usageLimits/i.test(text));
    if ((quota || res.status >= 500) && attempt < tries) {
      await wait((cfg.backoffMs ?? 500) * 2 ** (attempt - 1));
      continue;
    }
    const kind: GoogleErrorKind = /invalid_grant/.test(text)
      ? "invalid_grant"
      : quota
        ? "quota"
        : res.status === 404 || res.status === 410
          ? "not_found"
          : res.status === 401 || res.status === 403
            ? "auth"
            : "other";
    throw new GoogleError(`Google answered ${res.status}: ${text.slice(0, 200)}`, kind, res.status);
  }
}

const json = async <T>(res: Response) => (await res.json()) as T;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Where to send a manager to connect their Google Calendar. */
export function googleAuthUrl(cfg: GoogleConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: googleCalendarScopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${cfg.authorizeUrl}?${q}`;
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  email: string | null;
};

function emailOf(idToken: string | undefined): string | null {
  const part = idToken?.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

async function token(cfg: GoogleConfig, body: Record<string, string>) {
  const res = await call(cfg, cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
  });
  return json<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
    scope?: string;
  }>(res);
}

/** Swaps the code from Google's consent screen for tokens (and the account's email). */
export async function exchangeGoogleCode(
  cfg: GoogleConfig,
  code: string,
  now = new Date(),
): Promise<GoogleTokens & { scope: string }> {
  const t = await token(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(now.getTime() + t.expires_in * 1000),
    email: emailOf(t.id_token),
    scope: t.scope ?? "",
  };
}

export async function refreshGoogleToken(
  cfg: GoogleConfig,
  refreshToken: string,
  now = new Date(),
): Promise<{ accessToken: string; expiresAt: Date }> {
  const t = await token(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });
  return { accessToken: t.access_token, expiresAt: new Date(now.getTime() + t.expires_in * 1000) };
}

export async function revokeGoogleToken(cfg: GoogleConfig, tokenValue: string): Promise<void> {
  await call(
    cfg,
    cfg.revokeUrl,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokenValue }),
    },
    1,
  ).catch(() => {});
}

export type GoogleCalendar = { id: string; name: string; primary: boolean; timeZone: string | null };

/** The account's calendars it owns (events can only be added to owned ones with our scope). */
export async function listOwnedCalendars(cfg: GoogleConfig, accessToken: string): Promise<GoogleCalendar[]> {
  const out: GoogleCalendar[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({
      minAccessRole: "owner",
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await call(cfg, `${cfg.apiBase}/calendar/v3/users/me/calendarList?${q}`, {
      headers: bearer(accessToken),
    });
    const body = await json<{
      items?: {
        id: string;
        summary?: string;
        summaryOverride?: string;
        primary?: boolean;
        timeZone?: string;
        accessRole?: string;
      }[];
      nextPageToken?: string;
    }>(res);
    for (const c of body.items ?? [])
      if (c.accessRole === "owner")
        out.push({
          id: c.id,
          name: c.summaryOverride || c.summary || c.id,
          primary: !!c.primary,
          timeZone: c.timeZone ?? null,
        });
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** Busy times of one calendar between two instants. */
export async function googleFreeBusy(
  cfg: GoogleConfig,
  accessToken: string,
  calendarId: string,
  from: Date,
  to: Date,
): Promise<{ start: Date; end: Date }[]> {
  const res = await call(cfg, `${cfg.apiBase}/calendar/v3/freeBusy`, {
    method: "POST",
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    body: JSON.stringify({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: calendarId }],
    }),
  });
  const body = await json<{
    calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }>;
  }>(res);
  const cal = body.calendars?.[calendarId];
  if (cal?.errors?.length)
    throw new GoogleError(`Google couldn't read busy times (${cal.errors[0]?.reason}).`, "auth", null);
  return (cal?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export type GoogleEventInput = {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
};

export type GoogleEventResult = {
  id: string;
  meetUrl: string | null;
  meetStatus: "success" | "pending" | "failure" | null;
};

type RawEvent = {
  id: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
};

function eventResult(e: RawEvent): GoogleEventResult {
  const video =
    e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? e.hangoutLink ?? null;
  const code = e.conferenceData?.createRequest?.status?.statusCode;
  return {
    id: e.id,
    meetUrl: video,
    meetStatus: video ? "success" : code === "pending" ? "pending" : code === "failure" ? "failure" : null,
  };
}

const eventBody = (e: GoogleEventInput) => ({
  summary: e.summary,
  description: e.description,
  start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
  end: { dateTime: e.end.toISOString(), timeZone: e.timeZone },
  // Free in Google: Relay already counts its own bookings against the service's capacity.
  transparency: "transparent",
  reminders: { useDefault: true },
});

const events = (cfg: GoogleConfig, calendarId: string) =>
  `${cfg.apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

/**
 * Adds an event (no guests, no emails). `meetRequestId` asks Google for a Meet link; `eventId` (a-v,
 * 0-9) makes a retry safe: the same id again answers 409 instead of making a second event.
 */
export async function insertGoogleEvent(
  cfg: GoogleConfig,
  accessToken: string,
  calendarId: string,
  e: GoogleEventInput,
  opts: { meetRequestId?: string; eventId?: string } = {},
): Promise<GoogleEventResult> {
  const body = {
    ...eventBody(e),
    ...(opts.eventId ? { id: opts.eventId } : {}),
    ...(opts.meetRequestId
      ? {
          conferenceData: {
            createRequest: { requestId: opts.meetRequestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
          },
        }
      : {}),
  };
  const res = await call(cfg, `${events(cfg, calendarId)}?conferenceDataVersion=1&sendUpdates=none`, {
    method: "POST",
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return eventResult(await json<RawEvent>(res));
}

/**
 * A Google event id for a Relay booking: "rb" plus the hex of the booking id. Google only accepts
 * base32hex (0-9 and a-v), 5 to 1024 characters, so the prefix must not use w-z either.
 */
export const googleEventIdFor = (bookingId: string) =>
  `rb${[...new TextEncoder().encode(bookingId)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

export async function getGoogleEvent(
  cfg: GoogleConfig,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<GoogleEventResult> {
  const res = await call(
    cfg,
    `${events(cfg, calendarId)}/${encodeURIComponent(eventId)}?conferenceDataVersion=1`,
    {
      headers: bearer(accessToken),
    },
  );
  return eventResult(await json<RawEvent>(res));
}

export async function patchGoogleEvent(
  cfg: GoogleConfig,
  accessToken: string,
  calendarId: string,
  eventId: string,
  e: GoogleEventInput,
): Promise<GoogleEventResult> {
  const res = await call(
    cfg,
    `${events(cfg, calendarId)}/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`,
    {
      method: "PATCH",
      headers: { ...bearer(accessToken), "content-type": "application/json" },
      body: JSON.stringify(eventBody(e)),
    },
  );
  return eventResult(await json<RawEvent>(res));
}

/** Deletes an event; one already gone counts as deleted. */
export async function deleteGoogleEvent(
  cfg: GoogleConfig,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  try {
    await call(cfg, `${events(cfg, calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "DELETE",
      headers: bearer(accessToken),
    });
  } catch (err) {
    if (err instanceof GoogleError && err.kind === "not_found") return;
    throw err;
  }
}
