import { localTime, nextDate } from "./bookings";
import { type GoogleConfig, googleCall } from "./google-calendar";

/*
 * A small Google Tasks client: the account's task lists, a list Relay makes for WhatsApp follow-ups,
 * and adding or reading a task. Same OAuth client, retries and errors as the calendar one.
 *
 * Google Tasks keeps only the date of a task's due time (the time of day is dropped), so due dates
 * are plain local dates here and a time the customer asked for goes into the task's text.
 */

export const googleTasksScopes = ["openid", "email", "https://www.googleapis.com/auth/tasks"];

/** The list Relay offers to make when the business has no list for this yet. */
export const followUpListName = "WhatsApp follow-ups";

export type GoogleTaskList = { id: string; name: string };

const base = (cfg: GoogleConfig) => `${cfg.apiBase}/tasks/v1`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The account's task lists (Google gives every account at least "My Tasks"). */
export async function listTaskLists(cfg: GoogleConfig, accessToken: string): Promise<GoogleTaskList[]> {
  const lists: GoogleTaskList[] = [];
  let page: string | undefined;
  do {
    const q = new URLSearchParams({ maxResults: "100", ...(page ? { pageToken: page } : {}) });
    const res = await googleCall(cfg, `${base(cfg)}/users/@me/lists?${q}`, { headers: bearer(accessToken) });
    const body = (await res.json()) as {
      items?: { id: string; title?: string }[];
      nextPageToken?: string;
    };
    for (const l of body.items ?? []) lists.push({ id: l.id, name: l.title || "Untitled list" });
    page = body.nextPageToken;
  } while (page && lists.length < 500);
  return lists;
}

export async function createTaskList(
  cfg: GoogleConfig,
  accessToken: string,
  name: string,
): Promise<GoogleTaskList> {
  const res = await googleCall(cfg, `${base(cfg)}/users/@me/lists`, {
    method: "POST",
    headers: { ...bearer(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ title: name }),
  });
  const l = (await res.json()) as { id: string; title?: string };
  return { id: l.id, name: l.title || name };
}

export type GoogleTaskInput = {
  title: string;
  notes: string;
  /** Local date, YYYY-MM-DD (Google keeps only the date). */
  due: string | null;
};

export type GoogleTask = { id: string; status: "needsAction" | "completed"; link: string | null };

const taskOf = (t: { id: string; status?: string; webViewLink?: string }): GoogleTask => ({
  id: t.id,
  status: t.status === "completed" ? "completed" : "needsAction",
  link: t.webViewLink ?? null,
});

/** Adds a task at the top of a list. Not retried: a retry after a lost answer could add it twice. */
export async function insertGoogleTask(
  cfg: GoogleConfig,
  accessToken: string,
  listId: string,
  task: GoogleTaskInput,
): Promise<GoogleTask> {
  const res = await googleCall(
    cfg,
    `${base(cfg)}/lists/${encodeURIComponent(listId)}/tasks`,
    {
      method: "POST",
      headers: { ...bearer(accessToken), "content-type": "application/json" },
      body: JSON.stringify({
        title: task.title.slice(0, 1024),
        notes: task.notes.slice(0, 8192),
        ...(task.due ? { due: `${task.due}T00:00:00.000Z` } : {}),
      }),
    },
    1,
  );
  return taskOf((await res.json()) as { id: string; status?: string; webViewLink?: string });
}

/** A task's current state (has the team ticked it off?), or null when it was deleted. */
export async function getGoogleTask(
  cfg: GoogleConfig,
  accessToken: string,
  listId: string,
  taskId: string,
): Promise<GoogleTask | null> {
  try {
    const res = await googleCall(
      cfg,
      `${base(cfg)}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { headers: bearer(accessToken) },
    );
    const t = (await res.json()) as { id: string; status?: string; deleted?: boolean; webViewLink?: string };
    return t.deleted ? null : taskOf(t);
  } catch (err) {
    if ((err as { kind?: string }).kind === "not_found") return null;
    throw err;
  }
}

// ------------------------------------------------------------------ due dates

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * The local date a task is due, from what the agent says: "today", "tomorrow", a weekday (the next
 * one, never today) or a date. Worked out here so the model never counts days itself. A date in the
 * past becomes today; one more than a year away isn't accepted.
 */
export function taskDueDate(when: string | undefined, now: Date, timezone: string): string | null {
  const w = (when ?? "").trim().toLowerCase();
  if (!w) return null;
  const today = localTime(now, timezone);
  if (w === "today") return today.date;
  if (w === "tomorrow") return nextDate(today.date);
  const day = weekdays.indexOf(w) + 1;
  if (day > 0) {
    let date = nextDate(today.date);
    let weekday = (today.weekday % 7) + 1;
    while (weekday !== day) {
      date = nextDate(date);
      weekday = (weekday % 7) + 1;
    }
    return date;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w) || Number.isNaN(Date.parse(`${w}T00:00:00Z`))) return null;
  if (w < today.date) return today.date;
  const yearAhead = new Date(now.getTime() + 366 * 86_400_000).toISOString().slice(0, 10);
  return w > yearAhead ? null : w;
}

/** "Sun 22 Nov" for a local date. */
export function taskDueLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`)
    .toLocaleDateString("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(",", "");
}
