import { z } from "zod";

/*
 * The AI agent, shared by the API, the worker and the web app: the Kairos workflow name, what a run
 * is started with, and the settings a business edits.
 */

export const agentWorkflow = { name: "relay.mira", version: 1 } as const;

/** What starts an agent run in a chat. */
export type AgentRunInput = {
  agentId: string;
  organizationId: string;
  branchId: string;
  channelAccountId: string;
  conversationId: string;
  contactId: string;
  /** Unclaimed: no automation took the message. Automation: a "Hand to AI agent" step. */
  source: "unclaimed" | "automation";
  automationId?: string;
  /** The customer message that started it, answered first. */
  trigger: { messageId: string; text: string } | null;
  /** From the automation step: said first instead of answering the last message. */
  greeting?: string;
};

/** Labels on every agent run (the inbox's "stop on reply" and STOP rules read the same ones). */
export type AgentRunLabels = {
  agentId: string;
  contactId: string;
  conversationId: string;
  ai: true;
  stopOnAgentReply: true;
  stopOnOptOut: true;
};

/** Limits for one run in a chat. */
export const agentLimits = {
  /** Customer turns answered before the agent hands the chat to a person. */
  maxTurns: 30,
  /** Waiting this long with no message ends the run quietly (the chat is free again). */
  idleMs: 24 * 3_600_000,
  /** After a message, how long to wait for more before answering (several quick texts → one answer). */
  gatherMs: 3_500,
  /** At most this many extra messages are gathered into one turn. */
  gatherMax: 5,
  /** After a photo, voice note or video with no text, wait this long for the words that usually follow. */
  gatherAfterMediaMs: 8_000,
  /**
   * When the customer writes again while an answer is being written, the draft is dropped and the
   * turn answered again with everything; at most this many times in a row, so a reply always goes out.
   */
  maxRethinks: 2,
} as const;

export const agentHandoffSchema = z.object({
  when: z.string().max(1000).default(""),
  assignToUserId: z.string().nullable().default(null),
  message: z.string().max(500).default("I'm passing you to a person from our team. They'll reply here soon."),
});

export const agentHoursSchema = z
  .object({
    timezone: z.string().min(1),
    days: z.array(z.number().int().min(0).max(6)).min(1),
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .nullable();

/** Each setting's rule, with no defaults (a partial save must not reset what it doesn't send). */
const agentFields = {
  name: z.string().trim().min(1, "Give it a name").max(40),
  role: z.string().trim().max(120),
  instructions: z.string().max(8000),
  tone: z.string().trim().max(60),
  languages: z.array(z.string().trim().min(1).max(30)).max(8),
  model: z.enum(["fast", "smart"]),
  /** Voice notes: not heard, turned into text, or with the more accurate model (2× credits). */
  voiceNotes: z.enum(["off", "accurate", "best"]),
  /** Photos: not looked at, described, or with the more accurate model (2× credits). */
  photos: z.enum(["off", "accurate", "best"]),
  handoff: agentHandoffSchema,
  answerUnclaimed: z.boolean(),
  hours: agentHoursSchema,
  editableFields: z.array(z.string()).max(30),
  avatarFileId: z.string().nullable(),
};

/** A new agent's settings: anything not given gets its default. */
export const agentSettingsSchema = z.object({
  ...agentFields,
  role: agentFields.role.default(""),
  instructions: agentFields.instructions.default(""),
  tone: agentFields.tone.default("friendly"),
  languages: agentFields.languages.default([]),
  model: agentFields.model.default("fast"),
  voiceNotes: agentFields.voiceNotes.default("accurate"),
  photos: agentFields.photos.default("accurate"),
  answerUnclaimed: agentFields.answerUnclaimed.default(false),
  hours: agentFields.hours.default(null),
  editableFields: agentFields.editableFields.default([]),
  avatarFileId: agentFields.avatarFileId.default(null),
});

/** What the Teach and Go live pages save: only the settings sent change. */
export const agentPatchSchema = z.object(agentFields).partial();
export type AgentSettings = z.infer<typeof agentSettingsSchema>;

/** Starting points for the "Your job" text. */
export const agentStarters = [
  {
    id: "front_desk",
    label: "Front desk",
    role: "Front desk",
    instructions:
      "Greet customers and answer questions about our services, prices, timings and location.\nIf someone wants an appointment, ask for their preferred day and time and their name, then hand the chat to the team to confirm.\nKeep answers short and friendly.",
  },
  {
    id: "sales",
    label: "Sales assistant",
    role: "Sales assistant",
    instructions:
      "Help customers find the right product or service for them. Ask what they need and their budget, then suggest options from what you know.\nShare prices only from our information. When someone is ready to buy or wants a quote, collect their name and requirement and hand the chat to the team.",
  },
  {
    id: "support",
    label: "Customer support",
    role: "Customer support",
    instructions:
      "Help customers with questions and problems about our products and services, using our information.\nAsk for an order or booking number when it helps the team.\nIf you can't solve it, or the customer is unhappy, hand the chat to the team with a short summary.",
  },
] as const;

/** Whether `now` is inside the agent's hours (no hours: always). */
export function withinAgentHours(hours: z.infer<typeof agentHoursSchema>, now = new Date()): boolean {
  if (!hours) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hm = `${get("hour")}:${get("minute")}`;
  if (!hours.days.includes(day)) return false;
  return hours.from <= hours.to ? hm >= hours.from && hm < hours.to : hm >= hours.from || hm < hours.to;
}
