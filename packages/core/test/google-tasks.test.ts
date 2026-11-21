import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { googleAuthUrl } from "../src/google-calendar";
import {
  createTaskList,
  getGoogleTask,
  googleTasksScopes,
  insertGoogleTask,
  listTaskLists,
  taskDueDate,
  taskDueLabel,
} from "../src/google-tasks";
import { createFakeGoogle } from "./fake-google";

const tz = "Asia/Dubai";
// Saturday 21 Nov 2026, 23:30 in Dubai (19:30 UTC), when it is already 01:00 on Sunday in India.
const lateSaturday = new Date("2026-11-21T19:30:00Z");

describe("Google Tasks", () => {
  it("asks only for tasks (plus who the account is), on the same redirect address", () => {
    const g = createFakeGoogle();
    const url = new URL(googleAuthUrl(g.config, "st", googleTasksScopes));
    assert.equal(url.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/tasks");
    assert.equal(url.searchParams.get("redirect_uri"), g.config.redirectUri);
    assert.equal(url.searchParams.get("access_type"), "offline");
  });

  it("lists, makes a list, adds a task with a date-only due, and reads whether it's done", async () => {
    const g = createFakeGoogle();
    g.state.tokens.add("tok");
    assert.deepEqual(await listTaskLists(g.config, "tok"), [{ id: "list-my", name: "My Tasks" }]);
    const list = await createTaskList(g.config, "tok", "WhatsApp follow-ups");
    assert.equal(list.name, "WhatsApp follow-ups");
    const made = await insertGoogleTask(g.config, "tok", list.id, {
      title: "Call back Sam about Enterprise pricing",
      notes: "Wants a call after 5 pm.",
      due: "2026-11-22",
    });
    assert.equal(made.status, "needsAction");
    assert.equal(g.state.tasks[0]?.due, "2026-11-22T00:00:00.000Z");
    assert.equal(g.state.tasks[0]?.listId, list.id);
    (g.state.tasks[0] as { status: string }).status = "completed";
    assert.equal((await getGoogleTask(g.config, "tok", list.id, made.id))?.status, "completed");
    assert.equal(await getGoogleTask(g.config, "tok", list.id, "gone"), null);
  });

  it("never retries adding a task (a lost answer could add it twice)", async () => {
    const g = createFakeGoogle();
    g.state.tokens.add("tok");
    g.state.failNext = 1;
    await assert.rejects(insertGoogleTask(g.config, "tok", "list-my", { title: "x", notes: "", due: null }));
    assert.equal(g.state.tasks.length, 0);
    assert.equal(g.state.calls.filter((c) => c.startsWith("POST /tasks")).length, 1);
  });

  it("works out due dates in the branch's timezone, never in the past or a year out", () => {
    assert.equal(taskDueDate("today", lateSaturday, tz), "2026-11-21");
    assert.equal(taskDueDate("tomorrow", lateSaturday, tz), "2026-11-22");
    // Late Saturday in Dubai is still Saturday: the next Monday is the 23rd; "saturday" is next week.
    assert.equal(taskDueDate("Monday", lateSaturday, tz), "2026-11-23");
    assert.equal(taskDueDate("saturday", lateSaturday, tz), "2026-11-28");
    assert.equal(taskDueDate("2026-12-01", lateSaturday, tz), "2026-12-01");
    assert.equal(taskDueDate("2026-11-01", lateSaturday, tz), "2026-11-21");
    assert.equal(taskDueDate("2028-01-01", lateSaturday, tz), null);
    assert.equal(taskDueDate("next week sometime", lateSaturday, tz), null);
    assert.equal(taskDueDate(undefined, lateSaturday, tz), null);
    // Already Sunday in Kolkata at the same moment? No: 01:00 Sunday there, so today is the 22nd.
    assert.equal(taskDueDate("today", lateSaturday, "Asia/Kolkata"), "2026-11-22");
    assert.equal(taskDueLabel("2026-11-22"), "Sun 22 Nov");
  });
});
