import { toolNames } from "./builtins";
import { catalogToolNames, numbersIn, unknownAmounts } from "./catalog";
import { confirmField, toolArguments } from "./custom";
import { templatePhrases } from "./human";
import { whatsappText } from "./prompt";
import { envelope, runTool } from "./tools";
import type {
  AgentTool,
  ModelCaller,
  ModelResponse,
  RunContext,
  StepRunner,
  ToolCall,
  ToolResult,
  TurnOutcome,
  TurnResult,
  TurnTrace,
} from "./types";

export type TurnLimits = {
  /** Read/write tool calls per turn before the agent hands the chat over. */
  maxToolCalls: number;
  /** Model calls per turn. */
  maxModelCalls: number;
};

export const defaultLimits: TurnLimits = { maxToolCalls: 6, maxModelCalls: 5 };

export type TurnInput = {
  model: string;
  system: string;
  messages: unknown[];
  tools: AgentTool<unknown>[];
  ctx: RunContext;
  callModel: ModelCaller;
  /** Records each model call and tool call (Kairos step); the default just runs it. */
  step?: StepRunner;
  /** Name prefix for the steps, unique per turn ("turn3"). */
  stepPrefix?: string;
  limits?: Partial<TurnLimits>;
  /** Told after each recorded model call (usage rows). */
  onModelCall?: (response: ModelResponse, index: number) => Promise<void> | void;
};

const runDirect: StepRunner = (_name, fn) => fn();

/**
 * One customer turn: call the model, run the read/write tools it asks for (each recorded), feed the
 * results back, and stop at a reply, a reply with choices, a hand-over or a close. Bounded: too many
 * tool or model calls hand the chat to a person instead of looping.
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const limits = { ...defaultLimits, ...input.limits };
  const step = input.step ?? runDirect;
  const prefix = input.stepPrefix ?? "turn";
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const trace: TurnTrace = { calls: [], tools: [] };
  const messages = [...input.messages];
  let toolCount = 0;
  let rewroteMixed = false;
  let rewrotePrice = false;
  let rewroteTemplate = false;
  // With a catalogue, amounts in a reply must come from this chat or this turn's tool results.
  const priceGuard = byName.has(catalogToolNames.search);
  const known = priceGuard ? numbersIn(JSON.stringify(input.messages)) : new Set<number>();
  let retriedEmpty = false;

  for (let call = 0; call < limits.maxModelCalls; call++) {
    const response = await step(`${prefix}:model${call}`, () =>
      input.callModel({
        model: input.model,
        system: input.system,
        messages: [...messages],
        tools: input.tools,
      }),
    );
    trace.calls.push({ model: response.model, usage: response.usage, latencyMs: response.latencyMs });
    await input.onModelCall?.(response, call);

    const text = whatsappText(response.text);
    if (!response.toolCalls.length) {
      // Models sometimes type a tool call out as text ("close_chat{...}"). Never send that: an ending
      // tool is carried out as if it had been called; anything else is asked for again, properly.
      const typed = typedToolCall(response.text, byName);
      if (typed) {
        const tool = byName.get(typed.call.name) as AgentTool<unknown>;
        if (tool.kind !== "read" && tool.kind !== "write") {
          const outcome = endingOutcome(typed.call, typed.before, tool);
          if (outcome) return { outcome, trace };
        }
        messages.push(...response.messages, {
          role: "system",
          content: `That message was not sent: you wrote a tool call as text. Call ${typed.call.name} as a tool, or write your reply to the customer in plain words.`,
        });
        continue;
      }
      // Saying "I'll connect you with the team" without calling the tool leaves the customer waiting
      // for nobody, so a promise like that is carried out.
      if (text && byName.has(toolNames.handoff) && promisesHandover(text))
        return {
          outcome: {
            kind: "handoff",
            reason: "The customer wants to talk to the team",
            summary: `The assistant told the customer: "${text.slice(0, 300)}"`,
          },
          trace,
        };
      // A price nobody gave: ask once for a search first (it never reaches the customer).
      if (text && priceGuard && !rewrotePrice && unknownAmounts(text, known).length) {
        rewrotePrice = true;
        messages.push(...response.messages, {
          role: "system",
          content: `That message was not sent: it states a price (${unknownAmounts(text, known).join(", ")}) that isn't in your search results or this chat. Use ${catalogToolNames.search} or ${catalogToolNames.get} and quote only what they return, or say you'll check.`,
        });
        continue;
      }
      // A stray word from another language ("your team can जवाब faster"): ask once for a clean rewrite.
      if (text && !rewroteMixed && mixesScripts(text)) {
        rewroteMixed = true;
        messages.push(...response.messages, {
          role: "system",
          content:
            "That message was not sent: it mixed languages. Write it again entirely in the customer's language, with no words from any other language.",
        });
        continue;
      }
      // Template phrases ("I'd be happy to", "not just X but Y"): ask once to say it in plain words.
      const template = text && !rewroteTemplate ? templatePhrases(text) : [];
      if (template.length) {
        rewroteTemplate = true;
        messages.push(...response.messages, {
          role: "system",
          content: `That message was not sent: it reads like a template (${template.map((p) => `"${p}"`).join(", ")}). Say the same thing the way a person from the business would type it on WhatsApp: plain everyday words, short. Keep every time, date, price, link and reference exactly as it is.`,
        });
        continue;
      }
      if (text) return { outcome: { kind: "reply", text }, trace };
      // Nothing at all (the model only "thought" and stopped). The customer is waiting, so ask once
      // more; if it still says nothing, a person takes the chat rather than leaving it unanswered.
      if (!retriedEmpty) {
        retriedEmpty = true;
        messages.push(...response.messages, {
          role: "system",
          content:
            "You sent nothing, and the customer is waiting. Reply to them now, or call the tool you meant to use.",
        });
        continue;
      }
      return {
        outcome: {
          kind: "handoff",
          reason: "The assistant couldn't answer",
          summary: "The assistant gave no answer to the customer's last message twice in a row.",
        },
        trace,
      };
    }

    // A turn-ending tool wins over anything else asked for in the same response.
    const ending = response.toolCalls.find((c) => {
      const kind = byName.get(c.name)?.kind;
      return kind === "reply" || kind === "handoff" || kind === "end" || kind === "confirm";
    });
    if (ending) {
      const outcome = endingOutcome(ending, text, byName.get(ending.name) as AgentTool<unknown>);
      if (outcome) return { outcome, trace };
    }

    messages.push(...response.messages);
    const results: { call: ToolCall; result: ToolResult }[] = [];
    for (const toolCall of response.toolCalls) {
      const tool = byName.get(toolCall.name);
      let result: ToolResult;
      if (!tool) result = { ok: false, error: `There is no tool called ${toolCall.name}.` };
      else if (tool.kind !== "read" && tool.kind !== "write")
        result = { ok: false, error: "Use one ending tool at a time." };
      else if (++toolCount > limits.maxToolCalls) {
        return {
          outcome: {
            kind: "handoff",
            reason: "Needed too many steps to answer",
            summary: "The assistant could not finish this request in a few steps.",
          },
          trace,
        };
      } else {
        result = await step(`${prefix}:tool${toolCount}:${tool.name}`, () =>
          runTool(tool, toolCall.input, input.ctx),
        );
      }
      trace.tools.push({ name: toolCall.name, input: toolCall.input, result });
      if (priceGuard) for (const n of numbersIn(JSON.stringify(result))) known.add(n);
      results.push({ call: toolCall, result });
    }
    messages.push({
      role: "tool",
      content: results.map(({ call, result }) => ({
        type: "tool-result",
        toolCallId: call.id,
        toolName: call.name,
        output: { type: "json", value: envelope(result) },
      })),
    });
  }
  return {
    outcome: {
      kind: "handoff",
      reason: "Took too long to answer",
      summary: "The assistant went round in circles on this request.",
    },
    trace,
  };
}

/**
 * A tool call the model wrote as text instead of calling it: `close_chat{"reason":…}`, also with a
 * `functions.` prefix or in brackets, possibly after a few words. Unreadable input stays null, so the
 * tool's own check turns it down.
 */
export function typedToolCall(
  raw: string,
  tools: Map<string, AgentTool<unknown>>,
): { call: ToolCall; before: string } | null {
  for (const m of raw.matchAll(/(?:functions\.)?\b([a-z][a-z_]{2,40})\s*\(?\s*\{/g)) {
    const name = m[1] as string;
    if (!tools.has(name)) continue;
    const start = (m.index ?? 0) + m[0].lastIndexOf("{");
    const end = raw.lastIndexOf("}");
    let input: unknown = null;
    try {
      input = JSON.parse(raw.slice(start, end + 1));
    } catch {
      input = null;
    }
    return { call: { id: `typed_${name}`, name, input }, before: whatsappText(raw.slice(0, m.index)) };
  }
  return null;
}

/**
 * The agent saying it is handing the chat over right now ("I'll connect you with the team"), as opposed
 * to offering to ("I can connect you if you like?"). English only; the prompt covers other languages.
 */
export function promisesHandover(text: string): boolean {
  if (text.includes("?") || /\bif you\b/i.test(text)) return false;
  return /\b(?:I['’]ll|I will|I['’]m going to|I am going to|let me|I['’]m|I am)\s+(?:now\s+|just\s+|quickly\s+)?(?:connect|pass|hand|transfer|forward|put)(?:ing)?\s+you\b/i.test(
    text,
  );
}

/**
 * A reply in the Latin alphabet with a few words in another script dropped in. The other way round is
 * normal (a Hindi or Arabic reply naming "Relay" or "WhatsApp"), so only this direction counts.
 */
export function mixesScripts(text: string): boolean {
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const other =
    text.match(
      /[\p{Script=Devanagari}\p{Script=Arabic}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Malayalam}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Cyrillic}\p{Script=Han}]/gu,
    )?.length ?? 0;
  return other >= 2 && latin > other * 4;
}

/** Reads a turn-ending tool call. An invalid one returns null so the model's text (if any) is used. */
function endingOutcome(call: ToolCall, text: string, tool: AgentTool<unknown>): TurnOutcome | null {
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) return text ? { kind: "reply", text } : null;
  const data = parsed.data as Record<string, unknown>;
  if (tool.kind === "confirm" && tool.ref) {
    const question = whatsappText(String(data[confirmField] ?? "")) || text || `${tool.ref.title}?`;
    return {
      kind: "confirm",
      toolName: call.name,
      toolId: tool.ref.toolId,
      ...(tool.ref.mcpTool ? { mcpTool: tool.ref.mcpTool } : {}),
      input: toolArguments(data),
      text: question,
    };
  }
  if (call.name === toolNames.cantAnswer)
    return { kind: "reply", text: whatsappText(String(data.text)), gap: String(data.question) };
  if (call.name === toolNames.options) {
    const options = (data.options as string[]).map((title, i) => ({ id: `o${i + 1}`, title }));
    return {
      kind: "options",
      text: whatsappText(String(data.text)),
      options,
      ...(data.buttonText ? { buttonText: String(data.buttonText) } : {}),
    };
  }
  if (call.name === catalogToolNames.show)
    return {
      kind: "items",
      itemIds: [...new Set(data.itemIds as string[])],
      action: (data.action as "order" | "book" | "none") ?? "order",
      ...(data.text ? { text: whatsappText(String(data.text)) } : text ? { text } : {}),
    };
  if (call.name === catalogToolNames.media)
    return {
      kind: "media",
      itemId: String(data.itemId),
      ...(data.text ? { text: whatsappText(String(data.text)) } : {}),
    };
  if (tool.kind === "handoff")
    return {
      kind: "handoff",
      reason: String(data.reason),
      summary: String(data.summary),
      ...(text ? { text } : {}),
    };
  if (tool.kind === "end") {
    const last = whatsappText(String(data.text ?? "")) || text;
    return { kind: "close", reason: String(data.reason), ...(last ? { text: last } : {}) };
  }
  return null;
}
