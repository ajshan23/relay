import type { z } from "zod";

/**
 * Who and where a turn is for. The harness fills this in from the run; the model never sees or sets
 * it, so a tool can never be pointed at another business, branch or customer.
 */
export type RunContext = {
  orgId: string;
  branchId: string;
  agentId: string;
  conversationId: string | null;
  contactId: string | null;
  /** "test" in the Try panel: nothing reaches a customer. */
  mode: "live" | "test";
  timezone: string;
  now: Date;
};

/** What the business taught the agent (the stable part of the prompt). */
export type AgentProfile = {
  name: string;
  role: string;
  businessName: string;
  instructions: string;
  tone: string;
  /** Empty: answer in the customer's language. */
  languages: string[];
  /** Extra plain-words rule for when to hand over. */
  handoffWhen: string;
  /** The branch has a catalogue the agent can search and show. */
  catalog?: boolean;
  /** Voice notes are turned into text for the agent (its Voice notes setting isn't Off). */
  hearsVoiceNotes?: boolean;
  /** Photos are described in words for the agent (its Photos setting isn't Off). */
  seesPhotos?: boolean;
};

/** What the agent knows about the customer (volatile; placed after the history). */
export type ContactFacts = {
  name?: string | null;
  phone?: string | null;
  fields?: Record<string, string>;
  tags?: string[];
};

/** One message of the chat as the model sees it. */
export type ChatLine = {
  from: "customer" | "agent" | "team";
  text: string;
  at?: Date;
};

/**
 * What a tool is allowed to do. Read tools run and feed the model; the others end the turn and the
 * runtime carries them out as their own recorded steps (send, hand over, close).
 */
export type ToolKind = "read" | "write" | "reply" | "handoff" | "end";

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export type AgentTool<I = unknown> = {
  name: string;
  description: string;
  input: z.ZodType<I>;
  kind: ToolKind;
  /** Read and write tools run inside the turn. Reply, handoff and end tools have no run: they end it. */
  run?: (input: I, ctx: RunContext) => Promise<unknown>;
};

/** Tokens of one model call. */
export type Usage = {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};

export type ToolCall = { id: string; name: string; input: unknown };

/** What one model call returned, in a plain shape that a Kairos step can record and replay. */
export type ModelResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  latencyMs: number;
  /** The assistant message(s) to append before tool results (provider-neutral JSON). */
  messages: unknown[];
};

export type ModelRequest = {
  model: string;
  system: string;
  messages: unknown[];
  tools: AgentTool<unknown>[];
};

/** Calls a model. The real one wraps the AI SDK; tests pass a scripted fake. */
export type ModelCaller = (request: ModelRequest) => Promise<ModelResponse>;

/** Runs `fn` once and records its result (Kairos ctx.step in the worker; plain call elsewhere). */
export type StepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type TurnOutcome =
  /** gap: a question it couldn't answer from its knowledge (kept for "Improve"). */
  | { kind: "reply"; text: string; gap?: string }
  | { kind: "options"; text: string; options: { id: string; title: string }[]; buttonText?: string }
  | { kind: "handoff"; reason: string; summary: string; text?: string }
  | { kind: "close"; reason: string; text?: string }
  /** Show catalogue items (cards with the main photo, name, price and buttons). */
  | { kind: "items"; itemIds: string[]; text?: string; action: "order" | "book" | "none" }
  /** Send one item's whole gallery. */
  | { kind: "media"; itemId: string; text?: string }
  | { kind: "silent" };

export type TurnTrace = {
  calls: { model: string; usage: Usage; latencyMs: number }[];
  tools: { name: string; input: unknown; result: ToolResult }[];
};

export type TurnResult = { outcome: TurnOutcome; trace: TurnTrace };
