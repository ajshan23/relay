/*
 * Outbound message status only moves forward: queued < sending < accepted < sent < delivered < read.
 * Webhooks can arrive out of order (read before delivered), so a lower status never overwrites a
 * higher one. failed is final, except that a later delivered or read proves the message arrived.
 */

export type StoredStatus =
  | "received"
  | "queued"
  | "sending"
  | "accepted"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

const rank: Record<StoredStatus, number> = {
  received: 0,
  queued: 1,
  sending: 2,
  accepted: 3,
  sent: 4,
  delivered: 5,
  read: 6,
  failed: 7,
};

/** WhatsApp "played" (first play of a voice note) counts as read. */
export function toStoredStatus(status: "sent" | "delivered" | "read" | "played" | "failed"): StoredStatus {
  return status === "played" ? "read" : status;
}

/** Whether moving from `current` to `next` is a real step forward. */
export function shouldApplyStatus(current: StoredStatus, next: StoredStatus): boolean {
  if (current === next) return false;
  if (current === "failed") return next === "delivered" || next === "read";
  if (next === "failed") return current !== "delivered" && current !== "read";
  return rank[next] > rank[current];
}

/** End of the reply window after the customer's last message. */
export function windowExpiresAt(lastInboundAt: Date, windowHours: number): Date {
  return new Date(lastInboundAt.getTime() + windowHours * 60 * 60 * 1000);
}
