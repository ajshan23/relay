import type { AutomationDefinition } from "./definition";
import { nodeSpec, type TapTarget } from "./nodes";
import type { AutomationRunInput } from "./runtime";

/*
 * A run's history in plain words, for the Runs tab: what started it, what was sent, what the customer
 * answered (including taps on earlier buttons), and how it ended. Built from the run's recorded steps
 * and the version it ran on, so it reads the same however long ago the run was.
 */

export type HistoryTone = "normal" | "muted" | "customer" | "jump" | "warn" | "bad";

export type HistoryEntry = {
  at: string | null;
  text: string;
  tone: HistoryTone;
  /** A step this entry is about, to point at on the canvas. */
  nodeId?: string;
  /** A time to show with the text ("until …"), formatted by the reader in their own timezone. */
  until?: string;
  /** An answer saved under a name ({{answers.name}}). */
  saved?: { name: string; value: string };
};

export type HistoryStep = {
  name: string;
  kind: string;
  status: string;
  result: unknown;
  error: { message?: string } | null;
  startedAt: string | Date | null;
  completedAt: string | Date | null;
  wakeAt: string | Date | null;
};

/** A sent message, for quoting it: its type and text (or caption). */
export type MessagePreview = { type: string; text: string };

const iso = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const quote = (s: string, max = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};

/** "send_message:book#2:reply" → type, node, visit, part. */
function parseName(name: string) {
  const m = /^([a-z_]+):([^#:]+)#(\d+)(?::(.+))?$/.exec(name);
  return m ? { type: m[1] ?? "", node: m[2] ?? "", part: m[4] ?? "" } : null;
}

/** What a run's trigger was, in a few words: Keyword “hi”, Earlier button “Talk to someone”… */
export function startedBy(
  trigger: AutomationRunInput["trigger"],
  names: { user?: string | null; tag?: string | null } = {},
): string {
  switch (trigger.kind) {
    case "message":
      if (trigger.adId) return "Ad click";
      return trigger.text ? `Message ${quote(trigger.text, 40)}` : "A message";
    case "button":
      return `Earlier button ${quote(trigger.text ?? "", 40)}`;
    case "manual":
      return names.user ? `Run from chat by ${names.user}` : "Run from chat";
    case "tag":
      return names.tag ? `Tag ${quote(names.tag, 40)} added` : "Tag added";
    default:
      return "—";
  }
}

/** A step's name for the history: "Hand to a human", "Ask a question “How can we help?”". */
function stepTitle(def: AutomationDefinition, nodeId: string | undefined): string {
  if (!nodeId) return "the end";
  const node = def.nodes.find((n) => n.id === nodeId);
  const spec = node ? nodeSpec(node.type) : null;
  if (!node || !spec) return "a step that's no longer there";
  // Sends and questions read better with what they say: Send message “Here are our prices…”.
  if (["send_message", "ask_question"].includes(node.type)) {
    const parsed = spec.config.safeParse(node.config);
    const said = parsed.success ? spec.summary(parsed.data) : "";
    if (said) return `${spec.label} ${quote(said, 40)}`;
  }
  return spec.label;
}

function messageText(
  preview: MessagePreview | undefined,
  fallback: string,
): { text: string; kind: "text" | "media" } {
  if (!preview) return { text: fallback, kind: "text" };
  if (["image", "video", "audio", "document", "sticker"].includes(preview.type)) {
    const what =
      preview.type === "image" ? "a photo" : preview.type === "document" ? "a file" : `a ${preview.type}`;
    return { text: preview.text ? `${what}: ${quote(preview.text)}` : what, kind: "media" };
  }
  return { text: preview.text || fallback, kind: "text" };
}

export function describeRun(o: {
  def: AutomationDefinition;
  input: AutomationRunInput;
  steps: HistoryStep[];
  messages: Record<string, MessagePreview>;
  status: string;
  error: { message?: string } | null;
  createdAt: string | Date;
  finishedAt: string | Date | null;
  names?: { user?: string | null; tag?: string | null };
}): HistoryEntry[] {
  const { def, input, steps, messages } = o;
  const next = new Map(def.edges.map((e) => [`${e.source}:${e.sourceHandle}`, e.target]));
  /** What a step says, for "waiting for a reply to “…”": the question or message text. */
  const stepTitleText = (nodeId: string) => {
    const c = config(nodeId);
    return String(c.text ?? "") || stepTitle(def, nodeId);
  };
  const config = (nodeId: string) => {
    const node = def.nodes.find((n) => n.id === nodeId);
    const spec = node ? nodeSpec(node.type) : null;
    const parsed = node && spec ? spec.config.safeParse(node.config) : null;
    return (parsed?.success ? parsed.data : {}) as Record<string, unknown>;
  };
  const out: HistoryEntry[] = [];
  // A run that has ended can still have a last step recorded as waiting (stopped while it waited).
  const ended = ["completed", "failed", "cancelled"].includes(o.status);

  // How it started.
  const begun = startedBy(input.trigger, o.names);
  if (input.startAt) {
    out.push({
      at: iso(o.createdAt),
      tone: "jump",
      text: `Started by a tap on ${quote(input.startAt.value)} on an earlier message → ${stepTitle(def, next.get(`${input.startAt.node}:${input.startAt.handle}`))}`,
      nodeId: input.startAt.node,
      ...(input.startAt.saveAs ? { saved: { name: input.startAt.saveAs, value: input.startAt.value } } : {}),
    });
  } else out.push({ at: iso(o.createdAt), tone: "muted", text: `Started: ${begun}` });

  steps.forEach((s, i) => {
    const at = iso(s.completedAt ?? s.startedAt);
    if (s.name === "release chat") return;
    const p = parseName(s.name);
    if (!p) return;
    const { type, node, part } = p;
    if (part === "typing" || part.endsWith(":typing") || part === "pause" || part.endsWith(":pause")) return;
    if (part === "deadline" || part === "when") return;
    const result = s.result as Record<string, unknown> | null;
    const cfg = config(node);
    const failed = (r: Record<string, unknown> | null) =>
      r && r.ok === false ? `Couldn't send (${String(r.reason ?? "unknown").replace(/_/g, " ")})` : null;

    // A tap on an earlier button that jumped somewhere.
    if (part.startsWith("older_button")) {
      const t = s.result as TapTarget | null;
      if (!t) return;
      out.push({
        at,
        tone: "jump",
        text: `Tapped ${quote(t.value)} on an earlier message → ${stepTitle(def, next.get(`${t.node}:${t.handle}`))}`,
        nodeId: t.node,
        ...(t.saveAs ? { saved: { name: t.saveAs, value: t.value } } : {}),
      });
      return;
    }

    // Sends: the message itself, quoted from what was really sent.
    const isSend =
      (type === "send_message" && !part) ||
      (type === "send_template" && !part) ||
      (type === "ask_question" && (part === "ask" || part.startsWith("reask")));
    if (isSend) {
      const bad = failed(result);
      if (bad) {
        out.push({ at, tone: "bad", text: bad, nodeId: node });
        return;
      }
      const preview = messages[String(result?.messageId ?? "")];
      const fallback = String((part.startsWith("reask") ? cfg.retryText : cfg.text) ?? "");
      const m = messageText(preview, fallback);
      const verb =
        type === "send_template"
          ? "Sent the template"
          : type === "ask_question"
            ? part.startsWith("reask")
              ? "Asked again"
              : "Asked"
            : "Sent";
      out.push({
        at,
        tone: "normal",
        text: m.kind === "media" ? `${verb} ${m.text}` : `${verb} ${quote(m.text)}`,
        nodeId: node,
      });
      return;
    }

    // Waiting for the customer: their answer, or no reply.
    if (s.kind === "wait") {
      if (s.status === "waiting") {
        const open = s.wakeAt && new Date(s.wakeAt).getFullYear() < 9999;
        out.push({
          at: iso(s.startedAt),
          tone: "muted",
          text: ended
            ? `Was waiting for a reply to ${quote(stepTitleText(node), 40)} when it ${o.status === "cancelled" ? "was stopped" : "ended"}`
            : "Waiting for a reply",
          nodeId: node,
          ...(open && !ended ? { until: iso(s.wakeAt) ?? undefined } : {}),
        });
        return;
      }
      const r = result as { timedOut?: boolean; event?: { payload?: { text?: string } } } | null;
      if (r?.timedOut) {
        out.push({ at, tone: "warn", text: "No reply in time", nodeId: node });
        return;
      }
      const said = r?.event?.payload?.text ?? "";
      // What happened next with this answer: asked again (it didn't fit), or a jump (older button).
      const after = steps[i + 1] ? parseName(steps[i + 1]?.name ?? "") : null;
      const sameNode = after?.node === node;
      const retried =
        sameNode &&
        (/^re(ask)?\d/.test(after?.part ?? "") ||
          (after?.part.startsWith("older_button") && !steps[i + 1]?.result));
      const jumped = sameNode && after?.part.startsWith("older_button") && !!steps[i + 1]?.result;
      if (jumped) return; // the tap entry tells it
      const saveAs = typeof cfg.saveAs === "string" && cfg.saveAs ? cfg.saveAs : undefined;
      out.push({
        at,
        tone: retried ? "warn" : "customer",
        text: retried
          ? `Replied ${quote(said || "(nothing)")}, which didn't fit`
          : `Replied ${quote(said || "(nothing)")}`,
        nodeId: node,
        ...(saveAs && !retried ? { saved: { name: saveAs, value: said } } : {}),
      });
      return;
    }

    // Timed waits.
    if (s.kind === "sleep") {
      out.push({
        at: s.status === "waiting" ? iso(s.startedAt) : at,
        tone: "muted",
        text:
          s.status !== "waiting"
            ? "Waited"
            : ended
              ? `Was waiting when it ${o.status === "cancelled" ? "was stopped" : "ended"}, meant to carry on`
              : "Waiting",
        nodeId: node,
        ...(s.wakeAt ? { until: iso(s.wakeAt) ?? undefined } : {}),
      });
      return;
    }

    const title = stepTitle(def, node);
    const entry: HistoryEntry = { at, tone: "normal", text: title, nodeId: node };
    if (type === "condition") entry.text = `Checked a condition: ${s.result ? "yes" : "no"}`;
    else if (type === "add_tag") entry.text = "Added a tag";
    else if (type === "remove_tag") entry.text = "Removed a tag";
    else if (type === "set_field") entry.text = "Set a contact field";
    else if (type === "assign") entry.text = "Assigned the chat";
    else if (type === "add_note") entry.text = "Added a note";
    else if (type === "close_chat") entry.text = "Closed the chat";
    else if (type === "handoff") entry.text = "Handed the chat to a person";
    if (s.error?.message) {
      entry.tone = "bad";
      entry.text = `${entry.text}: ${s.error.message}`;
    }
    out.push(entry);
  });

  // How it ended.
  const end = iso(o.finishedAt);
  if (o.status === "completed") out.push({ at: end, tone: "muted", text: "Finished" });
  else if (o.status === "failed")
    out.push({ at: end, tone: "bad", text: `Failed: ${o.error?.message ?? "an error"}` });
  else if (o.status === "cancelled") out.push({ at: end, tone: "muted", text: "Stopped" });
  return out;
}
