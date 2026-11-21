import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentTool, ModelCaller, ModelResponse } from "./types";

/*
 * Mira on Claude, through the official Anthropic SDK. The harness speaks the AI SDK's message shapes
 * (user / assistant / system / tool), so this file turns those into Anthropic's and back. Claude's
 * own reply blocks (thinking included) are kept on the assistant message as `_anthropic` and sent
 * back exactly as received on the next call of the same turn.
 */

export type ClaudeEnv = { ANTHROPIC_API_KEY?: string; CLOUD_APIKEY?: string };

/** The Anthropic key: ANTHROPIC_API_KEY, or CLOUD_APIKEY as it was first named in .env. */
export function anthropicKey(env: ClaudeEnv): string | undefined {
  return env.ANTHROPIC_API_KEY || env.CLOUD_APIKEY || undefined;
}

export const isClaudeModel = (model: string) => model.startsWith("claude-");

type AnyMessage = { role: string; content: unknown; _anthropic?: unknown[] };
type ToolPart = { toolCallId: string; output?: { value?: unknown } };
type Out = Anthropic.MessageParam;

/** The harness's messages as Anthropic messages. */
export function toAnthropicMessages(messages: unknown[]): Out[] {
  const out: Out[] = [];
  for (const m of messages as AnyMessage[]) {
    const prev = out.at(-1);
    if (m.role === "user") out.push({ role: "user", content: textOf(m.content) });
    else if (m.role === "assistant") {
      if (m._anthropic)
        out.push({ role: "assistant", content: m._anthropic as Anthropic.ContentBlockParam[] });
      else out.push({ role: "assistant", content: textOf(m.content) || "…" });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: (m.content as ToolPart[]).map((p) => ({
          type: "tool_result" as const,
          tool_use_id: p.toolCallId,
          content: JSON.stringify(p.output?.value ?? null),
        })),
      });
    } else if (m.role === "system") {
      // A system message in the conversation has to follow a user turn; after a reply from the
      // model, the harness's note goes in as a clearly marked user message instead.
      const text = textOf(m.content);
      if (prev?.role === "user") out.push({ role: "system", content: text });
      else out.push({ role: "user", content: `[Note from the system, not the customer:] ${text}` });
    }
  }
  // The conversation has to start with the customer (a chat can open with our own message).
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "[The chat started.]" });
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

function toolDefinitions(tools: AgentTool<unknown>[]): Anthropic.Tool[] {
  return tools.map((t) => {
    const { $schema: _schema, ...schema } = z.toJSONSchema(t.input as z.ZodType) as Record<string, unknown>;
    return { name: t.name, description: t.description, input_schema: schema as Anthropic.Tool.InputSchema };
  });
}

/** Calls a Claude model. Effort low, like GPT's low reasoning effort: Mira answers chats, not puzzles. */
export function createClaudeCaller(env: ClaudeEnv, opts: { client?: Anthropic } = {}): ModelCaller {
  let client = opts.client ?? null;
  return async (request): Promise<ModelResponse> => {
    if (!client) {
      const apiKey = anthropicKey(env);
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set, so the Claude model can't reply.");
      client = new Anthropic({ apiKey, maxRetries: 2 });
    }
    const started = Date.now();
    const res = await client.messages.create({
      model: request.model,
      max_tokens: 4000,
      output_config: { effort: "low" },
      // Cached: the system prompt (and the tools before it) are the same on every call for an agent.
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      tools: toolDefinitions(request.tools),
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: toAnthropicMessages(request.messages),
    });
    if (res.stop_reason === "refusal")
      throw new Error(`Claude declined to answer (${res.stop_details?.category ?? "safety"})`);
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const u = res.usage;
    const cached = u.cache_read_input_tokens ?? 0;
    const written = u.cache_creation_input_tokens ?? 0;
    return {
      text,
      toolCalls: calls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
      usage: {
        inputTokens: u.input_tokens + cached + written,
        cachedTokens: cached,
        outputTokens: u.output_tokens,
      },
      model: res.model,
      latencyMs: Date.now() - started,
      // Plain JSON so a recorded step hands it back unchanged on replay.
      messages: [{ role: "assistant", content: text, _anthropic: JSON.parse(JSON.stringify(res.content)) }],
    };
  };
}
