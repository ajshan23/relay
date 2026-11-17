import { toolNames } from "./builtins";
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
    if (!response.toolCalls.length)
      return { outcome: text ? { kind: "reply", text } : { kind: "silent" }, trace };

    // A turn-ending tool wins over anything else asked for in the same response.
    const ending = response.toolCalls.find((c) => {
      const kind = byName.get(c.name)?.kind;
      return kind === "reply" || kind === "handoff" || kind === "end";
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

/** Reads a turn-ending tool call. An invalid one returns null so the model's text (if any) is used. */
function endingOutcome(call: ToolCall, text: string, tool: AgentTool<unknown>): TurnOutcome | null {
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) return text ? { kind: "reply", text } : null;
  const data = parsed.data as Record<string, unknown>;
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
