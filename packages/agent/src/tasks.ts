import { z } from "zod";
import { defineTool } from "./tools";
import type { AgentTool, RunContext } from "./types";

/*
 * Follow-ups for the team: when a person has to do something after the chat (call back, check a
 * question, send a quote), the agent adds a task to the business's Google Tasks. It's internal, so
 * the customer isn't asked first; the agent tells them what will happen.
 */

export const taskToolNames = { add: "add_follow_up_task" } as const;

export type FollowUpInput = { title: string; details: string; due?: string };

export type TaskDeps = {
  /** Adds it (or, in Try, says what would be added). The app works out the due date. */
  add: (input: FollowUpInput, ctx: RunContext) => Promise<unknown>;
};

export function taskTools(deps: TaskDeps): AgentTool<unknown>[] {
  return [
    defineTool({
      name: taskToolNames.add,
      kind: "write",
      description:
        "Add a follow-up task for the business's team (it goes to their Google Tasks). Use it when a person has to do something after this chat: call or message the customer back, check something you couldn't answer, send a quote, document or price they asked for, or anything you told the customer the team would do. Not for things you can do yourself, and not for bookings (use the booking tools). Add one task per thing to do, once; the chat's open follow-ups are listed in your notes. Then tell the customer plainly what the team will do. Never promise a time the business didn't agree to.",
      input: z.object({
        title: z
          .string()
          .trim()
          .min(3)
          .max(120)
          .describe("What to do, with the customer's name, e.g. 'Call back Sam about Enterprise pricing'"),
        details: z
          .string()
          .trim()
          .max(1000)
          .describe(
            "What the customer wants and anything the team needs: the time they asked to be called, items, amounts, their question in their words. In English.",
          ),
        due: z
          .string()
          .trim()
          .max(20)
          .optional()
          .describe(
            "When it should be done: 'today', 'tomorrow', a weekday ('monday') or a date (YYYY-MM-DD). Leave it out when no day came up.",
          ),
      }),
      run: (input, ctx) => deps.add(input, ctx),
    }),
  ];
}

/** The chat's open follow-ups, for the agent's notes (so it doesn't add the same one again). */
export function openFollowUpsNote(tasks: { title: string; due: string | null }[]): string | null {
  if (!tasks.length) return null;
  return [
    "Follow-ups already added for the team in this chat and not done yet:",
    ...tasks.map((t) => `- ${t.title}${t.due ? ` (due ${t.due})` : ""}`),
  ].join("\n");
}
