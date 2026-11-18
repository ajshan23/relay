import type { Usage } from "./types";

/*
 * Which model a choice means, and what it costs. Model names come from the environment so switching
 * provider or model is configuration, not code.
 */

export type ModelChoice = "fast" | "smart";

export const defaultChatModel = "gpt-5.4-mini";
export const embeddingModel = "text-embedding-3-small";

export function modelFor(choice: ModelChoice, env: Record<string, string | undefined> = process.env): string {
  if (choice === "smart") return env.AI_MODEL_SMART || env.AI_MODEL_FAST || defaultChatModel;
  return env.AI_MODEL_FAST || defaultChatModel;
}

/** US dollars per million tokens. Check against the provider's pricing page when adding one. */
type Price = { input: number; cachedInput: number; output: number };
const prices: Record<string, Price> = {
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "text-embedding-3-small": { input: 0.02, cachedInput: 0.02, output: 0 },
};

/** Cost in millionths of a dollar. Unknown models cost 0 (and are visible in usage by name). */
export function costMicros(model: string, usage: Usage): number {
  const p = prices[model] ?? prices[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!p) return 0;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return Math.round(fresh * p.input + usage.cachedTokens * p.cachedInput + usage.outputTokens * p.output);
}

/** Credits a business gets each month when no allowance is set for it. */
export const defaultMonthlyCredits = 1000;

/** One credit per customer turn answered, however many model calls it took. Tests in the browser are free. */
export function creditsFor(kind: "reply" | "embed" | "try", callIndexInTurn: number): number {
  return kind === "reply" && callIndexInTurn === 0 ? 1 : 0;
}

// ------------------------------------------------------------------ voice notes

/** Whether the agent listens to voice notes, and how carefully. "best" costs twice as much. */
export type VoiceNotesChoice = "off" | "accurate" | "best";

export function transcribeModelFor(
  choice: Exclude<VoiceNotesChoice, "off">,
  env: Record<string, string | undefined> = process.env,
): string {
  if (choice === "best") return env.AI_TRANSCRIBE_MODEL_BEST || "gpt-4o-transcribe";
  if (env.AI_TRANSCRIBE_MODEL) return env.AI_TRANSCRIBE_MODEL;
  // Cloudflare's Whisper when it's set up (free daily allowance, then far cheaper); otherwise OpenAI.
  return env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN ? cloudflareWhisper : "gpt-4o-mini-transcribe";
}

/** Whisper Large V3 Turbo on Cloudflare Workers AI. Models starting "@cf/" go to Cloudflare. */
export const cloudflareWhisper = "@cf/openai/whisper-large-v3-turbo";

/** US dollars per minute of audio (Cloudflare's after its free daily allowance). */
const transcribePerMinute: Record<string, number> = {
  [cloudflareWhisper]: 0.0005,
  "gpt-4o-mini-transcribe": 0.003,
  "gpt-4o-transcribe": 0.006,
  "whisper-1": 0.006,
};

export function transcribeCostMicros(model: string, seconds: number): number {
  const p = transcribePerMinute[model] ?? transcribePerMinute[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  return p ? Math.round((Math.max(0, seconds) / 60) * p * 1_000_000) : 0;
}

/** Credits for one voice note: 1 per started minute when accurate, 2 when more accurate. */
export function transcribeCredits(choice: Exclude<VoiceNotesChoice, "off">, seconds: number): number {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes * (choice === "best" ? 2 : 1);
}

export const voiceNoteLimits = {
  /** Longer notes aren't listened to (the agent asks for a short one or to type it). */
  maxSeconds: 180,
  /** How long a turn waits for a voice note that is still being downloaded. */
  waitMs: 20_000,
};
