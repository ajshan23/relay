import type { Trigger } from "./definition";

/*
 * Which live automation an inbound message starts. Only one automation starts per message: the most
 * specific trigger wins, then the most recently updated automation. Publishing warns when two live
 * automations on the same number could both match, so this choice is never a surprise.
 */

export type InboundMessage = {
  text: string;
  /** The contact's very first message to this number. */
  isFirstMessage: boolean;
  /** Set when the chat came from a click-to-WhatsApp ad. */
  adId?: string | null;
};

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function triggerMatches(trigger: Trigger, msg: InboundMessage): boolean {
  if (trigger.type === "ad_click") {
    if (!msg.adId) return false;
    return !trigger.adIds?.length || trigger.adIds.includes(msg.adId);
  }
  if (trigger.type !== "message_received") return false;
  if (trigger.mode === "any") return true;
  if (trigger.mode === "first_message") return msg.isFirstMessage;
  const text = normalize(msg.text);
  if (!text) return false;
  return (trigger.keywords ?? []).some((k) => {
    const kw = normalize(k);
    if (!kw) return false;
    if (trigger.match === "contains")
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(kw)}($|[^\\p{L}\\p{N}])`, "u").test(text);
    return text === kw;
  });
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Higher wins: a specific ad, then any ad, keywords, first message, any message. */
export function triggerPriority(trigger: Trigger): number {
  if (trigger.type === "ad_click") return trigger.adIds?.length ? 50 : 40;
  if (trigger.type !== "message_received") return 0;
  if (trigger.mode === "keyword") return 30;
  if (trigger.mode === "first_message") return 20;
  return 10;
}

export type Candidate = { id: string; trigger: Trigger; updatedAt: Date | string };

/** The automation an inbound message starts, if any. */
export function pickAutomation<T extends Candidate>(candidates: T[], msg: InboundMessage): T | null {
  const matching = candidates.filter((c) => triggerMatches(c.trigger, msg));
  matching.sort(
    (a, b) =>
      triggerPriority(b.trigger) - triggerPriority(a.trigger) ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return matching[0] ?? null;
}

/**
 * Whether one message could match both triggers (same number assumed). Used to warn on publish.
 * Returns a short reason, or null when they can't clash.
 */
export function triggersOverlap(a: Trigger, b: Trigger): string | null {
  const isMsg = (t: Trigger) => t.type === "message_received" || t.type === "ad_click";
  if (!isMsg(a) || !isMsg(b)) {
    if (a.type === "tag_added" && b.type === "tag_added" && a.tagId === b.tagId)
      return "Both start when the same tag is added.";
    return null;
  }
  const any = (t: Trigger) => t.type === "message_received" && t.mode === "any";
  if (any(a) || any(b)) return "One of them starts on any message.";
  if (a.type === "ad_click" && b.type === "ad_click") {
    if (!a.adIds?.length || !b.adIds?.length) return "Both start from ad clicks.";
    return a.adIds.some((x) => b.adIds?.includes(x)) ? "Both start from the same ad." : null;
  }
  if (a.type === "message_received" && b.type === "message_received") {
    if (a.mode === "first_message" && b.mode === "first_message") return "Both start on a first message.";
    if (a.mode === "keyword" && b.mode === "keyword") {
      const shared = (a.keywords ?? [])
        .map(normalize)
        .filter((k) => (b.keywords ?? []).map(normalize).includes(k));
      if (shared.length) return `Both use the keyword “${shared[0]}”.`;
      return null;
    }
    // A keyword in a contact's very first message matches both.
    return "A first message can also contain a keyword.";
  }
  return null;
}
