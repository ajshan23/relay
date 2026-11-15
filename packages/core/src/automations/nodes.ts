import { z } from "zod";
import type { FilterRule } from "../contacts";

/*
 * The step catalogue. Each step type has a versioned config schema, the handles (exits) it offers for a
 * given config, and a one-line summary for its card. The editor, the API's validation and the worker's
 * handlers all read this, so they can never disagree about what a step accepts.
 *
 * Changing a step's config shape means adding version + 1 with a pure migrate(), never editing a
 * version that has shipped: published automations keep running on the version they were saved with.
 */

export type NodeCategory = "message" | "logic" | "contact" | "chat";
export type Handle = { id: string; label: string };

export type NodeSpec<C = Record<string, unknown>> = {
  type: string;
  version: number;
  category: NodeCategory;
  label: string;
  description: string;
  config: z.ZodType<C>;
  /** A config a new step starts with. */
  defaults: () => C;
  handles: (config: C) => Handle[];
  summary: (config: C) => string;
  /** Sends a free-form message (needs the 24-hour window). */
  sendsFreeText?: boolean;
  /** Ends the run (no exits). */
  terminal?: boolean;
};

/** WhatsApp counts length in UTF-16 units, so an emoji takes two. */
export const utf16Length = (s: string) => s.length;

const tagId = z.string().min(1, "Pick a tag");
const variableName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and _ (start with a letter)");
const optionId = z.string().regex(/^[a-z0-9]{1,12}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const mediaSchema = z.object({
  kind: z.enum(["image", "video", "document", "audio"]),
  /** A stored upload, sent by our media pipeline. */
  fileId: z.string().min(1),
  name: z.string().max(200).optional(),
});

const sendMessage = z.object({
  text: z.string().max(4096).default(""),
  media: mediaSchema.nullable().default(null),
});

const sendTemplate = z.object({
  templateId: z.string().min(1, "Pick a template"),
  /** Template variable → text, which may use {{variables}}. */
  values: z.record(z.string(), z.string().max(1024)).default({}),
});

export const answerFormats = ["any", "number", "email", "phone", "date"] as const;
const askQuestion = z.object({
  text: z.string().min(1, "Write the question").max(1024),
  answer: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("buttons"),
      options: z
        .array(
          z.object({ id: optionId, title: z.string().trim().min(1, "Every option needs a title").max(24) }),
        )
        .min(1, "Add at least one option")
        .max(10, "WhatsApp allows at most 10 options"),
    }),
    z.object({ type: z.literal("text"), format: z.enum(answerFormats).default("any") }),
  ]),
  saveAs: variableName,
  /** Asking again after an answer that doesn't fit, before taking the "didn't understand" exit. */
  retries: z.number().int().min(1).max(5).default(2),
  retryText: z.string().max(1024).default("Sorry, I didn't get that. Please pick one of the options."),
  /** No answer within this long takes the "no reply" exit. */
  timeoutMinutes: z.number().int().min(5).max(10080).default(1440),
});

export const conditionRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("contact"),
    rule: z.object({ field: z.string().min(1), op: z.string().min(1), value: z.unknown().optional() }),
  }),
  z.object({
    kind: z.enum(["answer", "variable"]),
    name: z.string().min(1),
    op: z.enum(["is", "is_not", "contains", "is_empty", "is_not_empty", "gt", "lt"]),
    value: z.string().max(200).optional(),
  }),
  z.object({ kind: z.literal("window_open") }),
  z.object({
    kind: z.literal("business_hours"),
    /** 0 = Sunday … 6 = Saturday. */
    days: z.array(z.number().int().min(0).max(6)).min(1),
    from: time,
    to: time,
    timezone: z.string().min(1),
  }),
]);
export type ConditionRule = z.infer<typeof conditionRuleSchema>;

const condition = z.object({
  match: z.enum(["all", "any"]).default("all"),
  rules: z.array(conditionRuleSchema).min(1, "Add at least one rule").max(20),
});

const wait = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("delay"),
    amount: z.number().int().min(1).max(100_000),
    unit: z.enum(["minutes", "hours", "days"]),
  }),
  z.object({ mode: z.literal("until_time"), time, timezone: z.string().min(1) }),
]);

export const nodeSpecs = {
  send_message: {
    type: "send_message",
    version: 1,
    category: "message",
    label: "Send message",
    description: "Text, a photo, a video or a file.",
    config: sendMessage.refine((c) => c.text.trim() || c.media, "Write a message or add a file"),
    defaults: () => ({ text: "", media: null }),
    handles: () => [
      { id: "next", label: "Sent" },
      { id: "failed", label: "Couldn't send" },
    ],
    summary: (c) => (c.media ? `${c.media.kind}${c.text ? `: ${c.text}` : ""}` : c.text || "Empty message"),
    sendsFreeText: true,
  } satisfies NodeSpec<z.infer<typeof sendMessage>>,

  send_template: {
    type: "send_template",
    version: 1,
    category: "message",
    label: "Send template",
    description: "An approved template; works outside the 24-hour window.",
    config: sendTemplate,
    defaults: () => ({ templateId: "", values: {} }),
    handles: () => [
      { id: "next", label: "Sent" },
      { id: "failed", label: "Couldn't send" },
    ],
    summary: (c) => (c.templateId ? "Template" : "Pick a template"),
  } satisfies NodeSpec<z.infer<typeof sendTemplate>>,

  ask_question: {
    type: "ask_question",
    version: 1,
    category: "message",
    label: "Ask a question",
    description: "Ask, wait for the answer and save it.",
    config: askQuestion,
    defaults: () => ({
      text: "",
      answer: {
        type: "buttons",
        options: [
          { id: "a1", title: "Yes" },
          { id: "a2", title: "No" },
        ],
      },
      saveAs: "answer",
      retries: 2,
      retryText: "Sorry, I didn't get that. Please pick one of the options.",
      timeoutMinutes: 1440,
    }),
    handles: (c) => [
      ...(c.answer.type === "buttons"
        ? c.answer.options.map((o) => ({ id: `opt:${o.id}`, label: o.title }))
        : [{ id: "next", label: "Answered" }]),
      { id: "invalid", label: "Didn't understand" },
      { id: "no_reply", label: "No reply" },
      { id: "failed", label: "Couldn't send" },
    ],
    summary: (c) => c.text || "Write the question",
    sendsFreeText: true,
  } satisfies NodeSpec<z.infer<typeof askQuestion>>,

  condition: {
    type: "condition",
    version: 1,
    category: "logic",
    label: "Condition",
    description: "Go one way or the other.",
    config: condition,
    defaults: () => ({ match: "all", rules: [{ kind: "window_open" }] }),
    handles: () => [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    summary: (c) =>
      `${c.rules.length} rule${c.rules.length === 1 ? "" : "s"} (${c.match === "all" ? "all" : "any"})`,
  } satisfies NodeSpec<z.infer<typeof condition>>,

  wait: {
    type: "wait",
    version: 1,
    category: "logic",
    label: "Wait",
    description: "Pause, then carry on.",
    config: wait,
    defaults: () => ({ mode: "delay", amount: 1, unit: "hours" }),
    handles: () => [{ id: "next", label: "Then" }],
    summary: (c) =>
      c.mode === "delay"
        ? `${c.amount} ${c.amount === 1 ? c.unit.replace(/s$/, "") : c.unit}`
        : `Until ${c.time} (${c.timezone})`,
  } satisfies NodeSpec<z.infer<typeof wait>>,

  add_tag: tagStep("add_tag", "Add tag", "Tag the contact."),
  remove_tag: tagStep("remove_tag", "Remove tag", "Take a tag off the contact."),

  set_field: {
    type: "set_field",
    version: 1,
    category: "contact",
    label: "Set contact field",
    description: "Save a value on the contact.",
    config: z.object({ fieldKey: z.string().min(1, "Pick a field"), value: z.string().max(1024) }),
    defaults: () => ({ fieldKey: "", value: "" }),
    handles: () => [{ id: "next", label: "Then" }],
    summary: (c) => (c.fieldKey ? `${c.fieldKey} = ${c.value}` : "Pick a field"),
  } satisfies NodeSpec<{ fieldKey: string; value: string }>,

  assign: {
    type: "assign",
    version: 1,
    category: "chat",
    label: "Assign chat",
    description: "Give the chat to a team member, or unassign it.",
    config: z.object({ userId: z.string().nullable() }),
    defaults: () => ({ userId: null }),
    handles: () => [{ id: "next", label: "Then" }],
    summary: (c) => (c.userId ? "Assign" : "Unassign"),
  } satisfies NodeSpec<{ userId: string | null }>,

  add_note: {
    type: "add_note",
    version: 1,
    category: "chat",
    label: "Add note",
    description: "A private note in the chat for the team.",
    config: z.object({ text: z.string().min(1, "Write the note").max(4000) }),
    defaults: () => ({ text: "" }),
    handles: () => [{ id: "next", label: "Then" }],
    summary: (c) => c.text || "Write the note",
  } satisfies NodeSpec<{ text: string }>,

  close_chat: {
    type: "close_chat",
    version: 1,
    category: "chat",
    label: "Close chat",
    description: "Mark the chat closed.",
    config: z.object({}),
    defaults: () => ({}),
    handles: () => [{ id: "next", label: "Then" }],
    summary: () => "Close the chat",
  } satisfies NodeSpec<Record<string, never>>,

  handoff: {
    type: "handoff",
    version: 1,
    category: "chat",
    label: "Hand to a human",
    description: "Open the chat for the team and stop the automation.",
    config: z.object({ userId: z.string().nullable().default(null), note: z.string().max(4000).default("") }),
    defaults: () => ({ userId: null, note: "" }),
    handles: () => [],
    summary: (c) => (c.userId ? "Assign and stop" : "Open for the team and stop"),
    terminal: true,
  } satisfies NodeSpec<{ userId: string | null; note: string }>,

  end: {
    type: "end",
    version: 1,
    category: "logic",
    label: "End",
    description: "Stop the automation here.",
    config: z.object({}),
    defaults: () => ({}),
    handles: () => [],
    summary: () => "End",
    terminal: true,
  } satisfies NodeSpec<Record<string, never>>,
} as const;

function tagStep(type: "add_tag" | "remove_tag", label: string, description: string) {
  return {
    type,
    version: 1,
    category: "contact" as const,
    label,
    description,
    config: z.object({ tagId }),
    defaults: () => ({ tagId: "" }),
    handles: () => [{ id: "next", label: "Then" }],
    summary: (c: { tagId: string }) => (c.tagId ? label : "Pick a tag"),
  } satisfies NodeSpec<{ tagId: string }>;
}

export type NodeType = keyof typeof nodeSpecs;
export const nodeTypes = Object.keys(nodeSpecs) as NodeType[];

// biome-ignore lint/suspicious/noExplicitAny: the registry holds specs of every config shape
export function nodeSpec(type: string): NodeSpec<any> | null {
  return (nodeSpecs as Record<string, NodeSpec<unknown>>)[type] ?? null;
}

export type SendMessageConfig = z.infer<typeof sendMessage>;
export type SendTemplateConfig = z.infer<typeof sendTemplate>;
export type AskQuestionConfig = z.infer<typeof askQuestion>;
export type ConditionConfig = z.infer<typeof condition>;
export type WaitConfig = z.infer<typeof wait>;
export type ContactRule = FilterRule;

/** ≤3 options become WhatsApp reply buttons (titles ≤20); 4–10 a list (rows ≤24). */
export function askLayout(optionCount: number): "buttons" | "list" {
  return optionCount <= 3 ? "buttons" : "list";
}

/**
 * The id sent with each option of one question. It carries a short mark of the step that sent it, so a
 * tap on an older question's button (still on the customer's screen) is never taken as this answer.
 */
export function optionReplyId(stepKey: string, optionId: string): string {
  let h = 0;
  for (const ch of stepKey) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `q${(h >>> 0).toString(36)}_${optionId}`;
}

/** The option id inside a reply id, if it belongs to this step's question. */
export function optionFromReply(stepKey: string, replyId: string): string | null {
  const prefix = optionReplyId(stepKey, "");
  return replyId.startsWith(prefix) ? replyId.slice(prefix.length) || null : null;
}
