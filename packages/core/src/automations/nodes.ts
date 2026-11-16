import { z } from "zod";
import type { FilterRule } from "../contacts";
import type { AutomationDefinition } from "./definition";

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

/*
 * "Wait for a reply" on a send step: off by default, so steps saved before it existed behave the same.
 * On, the step waits for their next message (or a tap on one of the template's quick-reply buttons),
 * saves it under a name if one is given, and takes "No reply" after the timeout.
 */
const waitFields = {
  waitForReply: z.boolean().default(false),
  saveAs: z.union([variableName, z.literal("")]).default(""),
  timeoutMinutes: z.number().int().min(5).max(10080).default(1440),
};

const sendMessage = z.object({
  text: z.string().max(4096).default(""),
  media: mediaSchema.nullable().default(null),
  ...waitFields,
});

const sendTemplate = z.object({
  templateId: z.string().min(1, "Pick a template"),
  /** Template variable → text, which may use {{variables}}. */
  values: z.record(z.string(), z.string().max(1024)).default({}),
  /** The template's quick-reply buttons (copied when it's picked): each becomes an exit when waiting. */
  replyButtons: z.array(z.object({ index: z.number().int().min(0).max(9), title: z.string() })).default([]),
  ...waitFields,
});

const waitExits = (c: { waitForReply: boolean; timeoutMinutes: number }, replied = "Replied") =>
  c.waitForReply
    ? [
        { id: "replied", label: replied },
        { id: "no_reply", label: "No reply" },
      ]
    : [{ id: "next", label: "Sent" }];

/*
 * "Send link button": a message with one button that opens a page. The page is reached through a
 * short tracked link of ours, so a tap is seen; "Wait for a tap" turns that into Tapped / Not tapped.
 */
const sendLink = z.object({
  text: z.string().trim().min(1, "Write the message").max(1024, "At most 1024 characters"),
  buttonText: z
    .string()
    .trim()
    .min(1, "Write the button text")
    .max(20, "WhatsApp allows at most 20 characters on the button"),
  url: z
    .string()
    .trim()
    .min(1, "Add the link")
    .max(2000)
    .refine((u) => /^https:\/\/\S+$/i.test(u) || /^\{\{/.test(u), "Links start with https://"),
  media: z
    .object({
      kind: z.enum(["image", "video", "document"]),
      fileId: z.string().min(1),
      name: z.string().max(200).optional(),
    })
    .nullable()
    .default(null),
  footer: z.string().trim().max(60, "At most 60 characters").default(""),
  waitForTap: z.boolean().default(false),
  timeoutMinutes: z.number().int().min(5).max(10080).default(1440),
});

/** "Ask for location": WhatsApp's "Send location" request; the pin is saved under saveAs. */
const askLocation = z.object({
  text: z.string().trim().min(1, "Write the question").max(1024, "At most 1024 characters"),
  saveAs: variableName,
  /** A typed address counts too (saved without a pin), instead of asking again. */
  acceptTyped: z.boolean().default(false),
  retries: z.number().int().min(1).max(5).default(1),
  retryText: z.string().max(1024).default("Please tap “Send location” below to share where you are."),
  timeoutMinutes: z.number().int().min(5).max(10080).default(1440),
});

/** "Send location": a map pin chosen in the editor. */
const sendLocation = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().trim().max(100, "At most 100 characters").default(""),
    address: z.string().trim().max(300, "At most 300 characters").default(""),
  })
  .refine((c) => !(c.latitude === 0 && c.longitude === 0), "Choose the location");

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
    defaults: () => ({ text: "", media: null, waitForReply: false, saveAs: "", timeoutMinutes: 1440 }),
    handles: (c) => [...waitExits(c), { id: "failed", label: "Couldn't send" }],
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
    defaults: () => ({
      templateId: "",
      values: {},
      replyButtons: [],
      waitForReply: false,
      saveAs: "",
      timeoutMinutes: 1440,
    }),
    handles: (c) => [
      ...(c.waitForReply ? c.replyButtons.map((b) => ({ id: `btn:${b.index}`, label: b.title })) : []),
      ...waitExits(c, c.replyButtons.length ? "Replied something else" : "Replied"),
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

  send_link: {
    type: "send_link",
    version: 1,
    category: "message",
    label: "Send link button",
    description: "A message with a button that opens a page; see who tapped it.",
    config: sendLink,
    defaults: () => ({
      text: "",
      buttonText: "",
      url: "",
      media: null,
      footer: "",
      waitForTap: false,
      timeoutMinutes: 1440,
    }),
    handles: (c) => [
      ...(c.waitForTap
        ? [
            { id: "tapped", label: "Tapped" },
            { id: "not_tapped", label: "Not tapped" },
          ]
        : [{ id: "next", label: "Sent" }]),
      { id: "failed", label: "Couldn't send" },
    ],
    summary: (c) => (c.buttonText ? `${c.buttonText}: ${c.text}` : c.text || "Write the message"),
    sendsFreeText: true,
  } satisfies NodeSpec<z.infer<typeof sendLink>>,

  ask_location: {
    type: "ask_location",
    version: 1,
    category: "message",
    label: "Ask for location",
    description: "Ask them to share their location and save the pin.",
    config: askLocation,
    defaults: () => ({
      text: "",
      saveAs: "location",
      acceptTyped: false,
      retries: 1,
      retryText: "Please tap “Send location” below to share where you are.",
      timeoutMinutes: 1440,
    }),
    handles: () => [
      { id: "next", label: "Shared" },
      { id: "invalid", label: "Didn't share" },
      { id: "no_reply", label: "No reply" },
      { id: "failed", label: "Couldn't send" },
    ],
    summary: (c) => c.text || "Write the question",
    sendsFreeText: true,
  } satisfies NodeSpec<z.infer<typeof askLocation>>,

  send_location: {
    type: "send_location",
    version: 1,
    category: "message",
    label: "Send location",
    description: "A map pin they can open in their maps app.",
    config: sendLocation,
    defaults: () => ({ latitude: 0, longitude: 0, name: "", address: "" }),
    handles: () => [
      { id: "next", label: "Sent" },
      { id: "failed", label: "Couldn't send" },
    ],
    summary: (c) =>
      c.name ||
      c.address ||
      (c.latitude || c.longitude
        ? `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`
        : "Choose the location"),
    sendsFreeText: true,
  } satisfies NodeSpec<z.infer<typeof sendLocation>>,

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
export type SendLinkConfig = z.infer<typeof sendLink>;
export type AskLocationConfig = z.infer<typeof askLocation>;
export type SendLocationConfig = z.infer<typeof sendLocation>;

/** A shared location as an answer: {{answers.x}} reads `text`; the rest are {{answers.x.latitude}}… */
export type LocationAnswer = {
  text: string;
  latitude: number | null;
  longitude: number | null;
  name: string;
  address: string;
  map_link: string;
};

/** The answer for a shared pin, or for a typed address (no pin). */
export function locationAnswer(
  pin: { latitude: number; longitude: number; name?: string | null; address?: string | null } | null,
  typed = "",
): LocationAnswer {
  if (!pin) {
    const t = typed.trim();
    return {
      text: t,
      latitude: null,
      longitude: null,
      name: "",
      address: t,
      map_link: t ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)}` : "",
    };
  }
  const name = pin.name?.trim() ?? "";
  const address = pin.address?.trim() ?? "";
  const coords = `${pin.latitude},${pin.longitude}`;
  return {
    text: [name, address].filter(Boolean).join(", ") || coords,
    latitude: pin.latitude,
    longitude: pin.longitude,
    name,
    address,
    map_link: `https://www.google.com/maps?q=${coords}`,
  };
}
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

/** The option id inside any reply id we sent (whichever question it came from), or null. */
export function optionOfReply(replyId: string): string | null {
  return /^q[0-9a-z]+_(.+)$/.exec(replyId)?.[1] ?? null;
}

/** "run_x:menu#2" or "run_x:menu#2:re1" (a re-ask) → the run and the step that sent the message. */
export function parseStepKey(stepKey: string): { runId: string; nodeId: string } | null {
  const m = /^([^:]+):([^#:]+)#\d+/.exec(stepKey);
  return m?.[1] && m[2] ? { runId: m[1], nodeId: m[2] } : null;
}

/** Where a tap on one of an automation's buttons leads: that step's exit for the option. */
export type TapTarget = { node: string; handle: string; value: string; saveAs?: string };

/**
 * The exit a button leads to in this definition: an option of an "Ask a question" with buttons or a
 * list, or a quick-reply button of a template waiting for a reply. Null when that step or option isn't
 * in this version (the customer tapped a button from before an edit).
 */
export function tapTarget(def: AutomationDefinition, nodeId: string, optionId: string): TapTarget | null {
  const node = def.nodes.find((n) => n.id === nodeId);
  const spec = node ? nodeSpec(node.type) : null;
  if (!node || !spec) return null;
  const parsed = spec.config.safeParse(node.config);
  if (!parsed.success) return null;
  if (node.type === "ask_question") {
    const q = parsed.data as AskQuestionConfig;
    if (q.answer.type !== "buttons") return null;
    const opt = q.answer.options.find((o) => o.id === optionId);
    return opt ? { node: node.id, handle: `opt:${opt.id}`, value: opt.title, saveAs: q.saveAs } : null;
  }
  if (node.type === "send_template") {
    const t = parsed.data as SendTemplateConfig;
    const b = t.waitForReply ? t.replyButtons.find((x) => String(x.index) === optionId) : undefined;
    return b
      ? { node: node.id, handle: `btn:${b.index}`, value: b.title, saveAs: t.saveAs || undefined }
      : null;
  }
  return null;
}
