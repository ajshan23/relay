import { createOpenAI } from "@ai-sdk/openai";
import {
  embedMany,
  experimental_transcribe,
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  tool,
} from "ai";
import { embeddingModel } from "./models";
import type { AgentTool, ModelCaller, ModelResponse } from "./types";

/*
 * The real model calls, through the AI SDK. Everything else in this package works on plain shapes,
 * so adding a provider (Claude, Gemini) is a branch here and nothing else.
 */

export type ProviderEnv = {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_TOKEN?: string;
};

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

/** `dimensions` shortens the vectors (text-embedding-3 models), e.g. 512 for the catalogue. */
export function createEmbedder(env: ProviderEnv = process.env, opts: { dimensions?: number } = {}): Embedder {
  return async (values) => {
    const openai = openaiProvider(env);
    const result = await embedMany({
      model: openai.embedding(embeddingModel),
      values,
      maxParallelCalls: 2,
      ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
    });
    return { embeddings: result.embeddings, tokens: result.usage.tokens, model: embeddingModel };
  };
}

/** Turns a voice note into text. The language is detected (Arabic, Hindi, Malayalam, mixed…). */
export type Transcriber = (
  audio: Uint8Array,
  model: string,
) => Promise<{ text: string; language: string | null; seconds: number | null }>;

export function createTranscriber(
  env: ProviderEnv = process.env,
  fetcher: typeof fetch = fetch,
): Transcriber {
  return async (audio, model) => {
    if (model.startsWith("@cf/")) return cloudflareTranscribe(env, fetcher, audio, model);
    const openai = openaiProvider(env);
    const result = await experimental_transcribe({
      model: openai.transcription(model),
      audio,
      maxRetries: 2,
    });
    return {
      text: result.text.trim(),
      language: result.language ?? null,
      seconds: result.durationInSeconds ?? null,
    };
  };
}

/** Workers AI REST: the audio as base64 JSON; the answer is { result: { text, transcription_info } }. */
async function cloudflareTranscribe(
  env: ProviderEnv,
  fetcher: typeof fetch,
  audio: Uint8Array,
  model: string,
): Promise<{ text: string; language: string | null; seconds: number | null }> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_AI_TOKEN)
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN are needed for Cloudflare voice notes.");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${model}`;
  const body = JSON.stringify({ audio: Buffer.from(audio).toString("base64"), vad_filter: true });
  let last: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_AI_TOKEN}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message?: string }[];
      result?: {
        text?: string;
        transcription_info?: { text?: string; language?: string; duration?: number };
      };
    } | null;
    if (res.ok && json?.success !== false && json?.result) {
      const r = json.result;
      return {
        text: (r.text ?? r.transcription_info?.text ?? "").trim(),
        language: r.transcription_info?.language ?? null,
        seconds: r.transcription_info?.duration ?? null,
      };
    }
    last = new Error(
      `Cloudflare transcription failed (${res.status}): ${json?.errors?.[0]?.message ?? "no details"}`,
    );
    // Bad token or account, bad audio: retrying won't help.
    if (res.status < 500 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw last ?? new Error("Cloudflare transcription failed");
}
