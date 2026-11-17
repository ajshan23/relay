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
