import { createOpenAI } from "@ai-sdk/openai";
import { embedMany, generateText, type LanguageModel, type ModelMessage, type ToolSet, tool } from "ai";
import { embeddingModel } from "./models";
import type { AgentTool, ModelCaller, ModelResponse } from "./types";

/*
 * The real model calls, through the AI SDK. Everything else in this package works on plain shapes,
 * so adding a provider (Claude, Gemini) is a branch here and nothing else.
 */

export type ProviderEnv = { OPENAI_API_KEY?: string; OPENAI_BASE_URL?: string };

/** True when replies can be made (a key is set). */
export function aiConfigured(env: ProviderEnv = process.env): boolean {
  return !!env.OPENAI_API_KEY;
}

function openaiProvider(env: ProviderEnv) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set, so the AI agent can't reply.");
  return createOpenAI({
    apiKey: env.OPENAI_API_KEY,
    ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
  });
}

/** Tool definitions for the model: description and input only. Running them is the harness's job. */
function toolSet(tools: AgentTool<unknown>[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [t.name, tool({ description: t.description, inputSchema: t.input })]),
  );
}

export function createModelCaller(
  env: ProviderEnv = process.env,
  opts: { cacheKey?: string; languageModel?: (id: string) => LanguageModel } = {},
): ModelCaller {
  return async (request) => {
    const model = opts.languageModel ? opts.languageModel(request.model) : openaiProvider(env)(request.model);
    const started = Date.now();
    const result = await generateText({
      model,
      instructions: request.system,
      messages: request.messages as ModelMessage[],
      // Only the harness writes system messages (the per-turn context note); customer text is always "user".
      allowSystemInMessages: true,
      tools: toolSet(request.tools),
      maxRetries: 2,
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          parallelToolCalls: false,
          ...(opts.cacheKey ? { promptCacheKey: opts.cacheKey } : {}),
        },
      },
    });
    const response: ModelResponse = {
      text: result.text,
      toolCalls: result.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input })),
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        cachedTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
      model: result.response.modelId || request.model,
      latencyMs: Date.now() - started,
      // Plain JSON so the step that recorded it can hand it back unchanged on replay.
      messages: JSON.parse(JSON.stringify(result.responseMessages)),
    };
    return response;
  };
}

export type Embedder = (
  values: string[],
) => Promise<{ embeddings: number[][]; tokens: number; model: string }>;

export function createEmbedder(env: ProviderEnv = process.env): Embedder {
  return async (values) => {
    const openai = openaiProvider(env);
    const result = await embedMany({ model: openai.embedding(embeddingModel), values, maxParallelCalls: 2 });
    return { embeddings: result.embeddings, tokens: result.usage.tokens, model: embeddingModel };
  };
}
