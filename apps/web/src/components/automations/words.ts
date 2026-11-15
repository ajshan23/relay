import type { AutomationDefinition } from "@relay/core/automations";
import type { Tone } from "@relay/ui/components/tag";
import type { AutomationStatus, EditorOptions } from "./queries";

export const statusLabel: Record<AutomationStatus, string> = {
  draft: "Draft",
  live: "Live",
  paused: "Paused",
  archived: "Archived",
};
export const statusTone: Record<AutomationStatus, Tone> = {
  draft: "plain",
  live: "good",
  paused: "warning",
  archived: "plain",
};

export const runStatusLabel: Record<string, string> = {
  queued: "Starting",
  running: "Running",
  sleeping: "Waiting (timer)",
  waiting: "Waiting for a reply",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
};
export const runStatusTone: Record<string, Tone> = {
  queued: "primary",
  running: "primary",
  sleeping: "plain",
  waiting: "plain",
  completed: "good",
  failed: "danger",
  cancelled: "plain",
};

export const triggerLabels: Record<AutomationDefinition["trigger"]["type"], string> = {
  message_received: "A message arrives",
  ad_click: "Someone messages from an ad",
  tag_added: "A tag is added",
  run_from_chat: "A team member runs it from a chat",
};

export function triggerSummary(def: AutomationDefinition, options?: EditorOptions): string {
  const t = def.trigger;
  if (t.type === "message_received") {
    if (t.mode === "any") return "Any message";
    if (t.mode === "first_message") return "Their very first message";
    const kw = (t.keywords ?? []).map((k) => `“${k}”`).join(", ");
    return kw ? `Message ${t.match === "contains" ? "contains" : "is"} ${kw}` : "Add keywords";
  }
  if (t.type === "ad_click")
    return t.adIds?.length ? `Ads ${t.adIds.join(", ")}` : "Any click-to-WhatsApp ad";
  if (t.type === "tag_added") {
    const tag = options?.tags.find((x) => x.id === t.tagId);
    return tag ? `Tag “${tag.name}” added` : "Pick a tag";
  }
  return "Started from a chat by a team member";
}

export function when(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function took(from: string, to: string | null): string {
  if (!to) return "—";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} days`;
}
