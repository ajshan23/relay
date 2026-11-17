import { z } from "zod";
import { defineTool } from "./tools";
import type { AgentTool, RunContext } from "./types";

/** A piece of knowledge returned to the model. */
export type KnowledgeHit = { source: string; text: string };

/** What the built-in tools need from the app (database work lives outside this package). */
export type BuiltinDeps = {
  searchKnowledge: (query: string, ctx: RunContext) => Promise<KnowledgeHit[]>;
  /** Called when a search finds nothing: the question is kept for "Improve". */
  noteGap?: (question: string, ctx: RunContext) => Promise<void>;
  updateContact?: (
    change: { fields: Record<string, string>; addTags: string[] },
    ctx: RunContext,
  ) => Promise<{ saved: string[] }>;
  /** Contact field keys the business lets the agent fill in. Empty: only tags. */
  editableFields: { key: string; label: string }[];
};

export const toolNames = {
  search: "search_knowledge",
  options: "reply_with_options",
  handoff: "hand_to_person",
  updateContact: "update_contact",
  close: "close_chat",
} as const;

/** The tools every agent has. Later phases add booking, catalogue and custom ones next to these. */
export function builtinTools(deps: BuiltinDeps): AgentTool<unknown>[] {
  const tools: AgentTool<unknown>[] = [
    defineTool({
      name: toolNames.search,
      kind: "read",
      description:
        "Search what the business has taught you (notes, questions and answers, files, its website). Use it before answering any question about the business: services, prices, timings, location, policies. Search with the customer's words, in their language or English.",
      input: z.object({ query: z.string().min(2).max(300).describe("What to look for") }),
      run: async ({ query }, ctx) => {
        const hits = await deps.searchKnowledge(query, ctx);
        if (!hits.length) {
          await deps.noteGap?.(query, ctx);
          return {
            found: false,
            results: [],
            hint: "Nothing found. Don't guess: say you'll check, or hand over.",
          };
        }
        return { found: true, results: hits };
      },
    }),
    defineTool({
      name: toolNames.options,
      kind: "reply",
      description:
        "Reply and let the customer pick from a few clear choices. Up to 3 choices show as buttons, up to 10 as a list. Ends your turn.",
      input: z.object({
        text: z.string().min(1).max(1000).describe("The message above the choices"),
        options: z
          .array(z.string().min(1).max(24))
          .min(2)
          .max(10)
          .describe("Short choice labels, 24 characters at most"),
        buttonText: z.string().max(20).optional().describe("List button label, e.g. 'Choose'"),
      }),
    }),
    defineTool({
      name: toolNames.handoff,
      kind: "handoff",
      description:
        "Hand the chat to a person on the team. Use it when the customer asks for a person, when you can't help after searching, when they're upset, or when the business's rules say so. Ends your part of the chat.",
      input: z.object({
        reason: z.string().min(2).max(200).describe("Why, in a few words, for the team"),
        summary: z
          .string()
          .min(2)
          .max(600)
          .describe("What the customer wants and what you've done so far, for the team"),
      }),
    }),
    defineTool({
      name: toolNames.close,
      kind: "end",
      description:
        "Close the chat when the customer is done (they said thanks or goodbye and need nothing else). You may include a last short message.",
      input: z.object({
        reason: z.string().min(2).max(200),
        text: z.string().max(500).optional().describe("A last short message, if one fits"),
      }),
    }),
  ];
  if (deps.updateContact) {
    const update = deps.updateContact;
    const keys = deps.editableFields.map((f) => f.key);
    const fieldList = deps.editableFields.map((f) => `${f.key} (${f.label})`).join(", ");
    tools.push(
      defineTool({
        name: toolNames.updateContact,
        kind: "write",
        description: `Save something the customer told you about themselves to their contact card.${
          keys.length ? ` Fields you may fill: ${fieldList}.` : " You may only add tags."
        } Only save what they actually said.`,
        input: z.object({
          fields: z.record(z.string(), z.string().max(500)).default({}),
          addTags: z.array(z.string().min(1).max(40)).max(5).default([]),
        }),
        run: async (input, ctx) => {
          const fields = Object.fromEntries(Object.entries(input.fields).filter(([k]) => keys.includes(k)));
          const dropped = Object.keys(input.fields).filter((k) => !keys.includes(k));
          const res = await update({ fields, addTags: input.addTags }, ctx);
          return dropped.length ? { ...res, notAllowed: dropped } : res;
        },
      }),
    );
  }
  return tools;
}
