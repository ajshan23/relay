import type { BroadcastErrorAction } from "../types";

/*
 * WhatsApp Cloud API errors, as they matter to a broadcast. Sources: Meta's error code reference and
 * the messaging-limits and template-quality docs. Anything unknown is treated as a final failure for
 * that person, and the broadcast's error-rate breaker pauses it if many messages fail the same way.
 */

const HOUR = 3_600_000;

export function whatsappBroadcastError(
  code: number | string | null | undefined,
  message = "",
): BroadcastErrorAction {
  switch (Number(code)) {
    // This person reached Meta's limit on marketing messages for now.
    case 131049:
      return {
        action: "held_back",
        afterMs: 24 * HOUR,
        reason: "Meta held this back: they already got enough marketing messages for now",
      };
    // They turned off marketing messages from this business.
    case 131050:
      return { action: "opt_out", reason: "They stopped marketing messages" };
    // Not on WhatsApp, or an app too old to show the message.
    case 131026:
      return { action: "final", reason: "Can't be delivered (not on WhatsApp, or an old app)" };
    case 131021:
      return { action: "final", reason: "That's the business's own number" };
    // Too many messages to the same person in a short time.
    case 131056:
      return { action: "retry", afterMs: 60_000, reason: "Too many messages to this person at once" };
    // Throughput for the number reached.
    case 130429:
    case 4:
    case 80007:
      return { action: "slow", afterMs: 30_000, reason: "Sending too fast for this number" };
    // Meta's spam limits.
    case 131048:
      return {
        action: "pause",
        pauseReason: "spam_limit",
        reason: "Meta limited sending because of spam reports",
      };
    case 132015:
      return {
        action: "pause",
        pauseReason: "template_paused",
        reason: "Meta paused the template for low quality",
      };
    case 132016:
      return { action: "pause", pauseReason: "template_disabled", reason: "Meta disabled the template" };
    // The template or its details are wrong: every message would fail the same way.
    case 132000:
    case 132001:
    case 132005:
    case 132007:
    case 132012:
    case 132068:
    case 132069:
      return {
        action: "stop",
        pauseReason: "template_invalid",
        reason: message || "The template can't be sent as set up",
      };
    // Billing and account problems.
    case 131042:
      return {
        action: "pause",
        pauseReason: "billing",
        reason: "Meta reports a payment problem on the account",
      };
    case 131031:
    case 368:
    case 131045:
      return { action: "pause", pauseReason: "account", reason: message || "Meta restricted the account" };
    case 190:
    case 0:
    case 10:
    case 200:
    case 131005:
      return {
        action: "pause",
        pauseReason: "auth",
        reason: "The channel's access stopped working; reconnect it",
      };
    // Temporary trouble at Meta.
    case 1:
    case 2:
    case 131000:
    case 131016:
    case 133004:
      return { action: "retry", afterMs: 5 * 60_000, reason: "WhatsApp had a temporary problem" };
    default:
      return { action: "final", reason: message || `WhatsApp error ${code ?? ""}`.trim() };
  }
}

/** People per rolling 24 h from Meta's tier name ("TIER_2K"); -1 for unlimited; null if unknown. */
export function whatsappTier(tier: string | undefined | null): number | null {
  if (!tier) return null;
  if (/UNLIMITED/i.test(tier)) return -1;
  const m = /(\d+)\s*(K)?/i.exec(tier);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}
