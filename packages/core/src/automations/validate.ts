import { type AutomationDefinition, TRIGGER_NODE_ID } from "./definition";
import { type AskQuestionConfig, askLayout, type ConditionConfig, nodeSpec, type WaitConfig } from "./nodes";
import { variableRoots, variablesUsed } from "./variables";

/*
 * Checks a definition before publishing (and live in the editor). Errors block publishing; warnings
 * need an explicit "publish anyway". Every issue names the step it's about, so the editor can mark it.
 *
 * Built from FlowFlex lessons: every question must have a way out (no reply, didn't understand), a loop
 * must wait somewhere, sizes have hard limits, answers are read by name, and a free-text message that
 * could go out after WhatsApp's 24-hour window is flagged before it fails in production.
 */

export const LIMITS = {
  maxSteps: 150,
  /** Steps one run may execute in total (loops included). Enforced by the engine. */
  maxExecutions: 500,
  /** Times one run may pass through the same step. Enforced by the engine. */
  maxVisitsPerStep: 25,
  /** A run older than this is stopped. Enforced by the engine. */
  lifetimeDays: 30,
  windowHours: 24,
} as const;

export type Issue = { level: "error" | "warning"; code: string; message: string; nodeId?: string };

export type ValidationContext = {
  /** Tag ids of the business; missing tags are errors when given. */
  tags?: Set<string>;
  /** Custom contact field keys; unknown {{contact.x}} is a warning when given. */
  fields?: Set<string>;
  /** Team members the chat can be assigned to. */
  assignees?: Set<string>;
  templates?: Map<string, { name: string; status: string; variables: string[] }>;
};

const coreContactVars = new Set(["name", "first_name", "phone", "email", "username"]);

export function validateDefinition(def: AutomationDefinition, ctx: ValidationContext = {}): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string, nodeId?: string) =>
    issues.push({ level: "error", code, message, nodeId });
  const warn = (code: string, message: string, nodeId?: string) =>
    issues.push({ level: "warning", code, message, nodeId });

  const nodes = new Map(def.nodes.map((n) => [n.id, n]));
  if (nodes.size !== def.nodes.length) err("DUPLICATE_NODE", "Two steps share an id.");
  if (nodes.has(TRIGGER_NODE_ID)) err("RESERVED_ID", `"${TRIGGER_NODE_ID}" can't be a step id.`);
  if (def.nodes.length > LIMITS.maxSteps)
    err(
      "TOO_MANY_STEPS",
      `An automation can have at most ${LIMITS.maxSteps} steps (this one has ${def.nodes.length}).`,
    );

  // Trigger
  if (
    def.trigger.type === "message_received" &&
    def.trigger.mode === "keyword" &&
    !def.trigger.keywords?.length
  )
    err("TRIGGER_KEYWORDS", "Add at least one keyword to the trigger.", TRIGGER_NODE_ID);
  if (def.trigger.type === "tag_added" && ctx.tags && !ctx.tags.has(def.trigger.tagId))
    err("TAG_MISSING", "The trigger's tag doesn't exist any more.", TRIGGER_NODE_ID);
  if (def.rules.reentry === "cooldown" && !def.rules.cooldownHours)
    err("COOLDOWN_HOURS", "Set how many hours to wait before someone can enter again.", TRIGGER_NODE_ID);

  // Each step's settings
  const handlesOf = new Map<string, Set<string>>();
  handlesOf.set(TRIGGER_NODE_ID, new Set(["next"]));
  const configs = new Map<string, Record<string, unknown>>();
  for (const n of def.nodes) {
    const spec = nodeSpec(n.type);
    if (!spec) {
      err("UNKNOWN_STEP", `Unknown step type "${n.type}".`, n.id);
      continue;
    }
    if (n.version !== spec.version) {
      err("STEP_VERSION", `This ${spec.label} step was saved by a newer version of Relay.`, n.id);
      continue;
    }
    const parsed = spec.config.safeParse(n.config);
    if (!parsed.success) {
      for (const i of parsed.error.issues.slice(0, 3)) err("STEP_SETTINGS", i.message, n.id);
      continue;
    }
    configs.set(n.id, parsed.data as Record<string, unknown>);
    handlesOf.set(n.id, new Set(spec.handles(parsed.data).map((h) => h.id)));
  }

  // Edges
  const out = new Map<string, Map<string, string>>(); // node → handle → target
  for (const e of def.edges) {
    if (!handlesOf.has(e.source) && !nodes.has(e.source)) {
      err("EDGE_SOURCE", "A connection starts from a step that no longer exists.");
      continue;
    }
    if (!nodes.has(e.target)) {
      err("EDGE_TARGET", "A connection leads to a step that no longer exists.", e.source);
      continue;
    }
    const handles = handlesOf.get(e.source);
    if (handles && !handles.has(e.sourceHandle)) {
      err("EDGE_HANDLE", "A connection comes from an exit this step doesn't have any more.", e.source);
      continue;
    }
    const byHandle = out.get(e.source) ?? new Map<string, string>();
    if (byHandle.has(e.sourceHandle)) err("EDGE_DUPLICATE", "One exit is connected twice.", e.source);
    byHandle.set(e.sourceHandle, e.target);
    out.set(e.source, byHandle);
  }
  if (!out.get(TRIGGER_NODE_ID)?.size)
    warn("EMPTY", "Nothing happens after the trigger yet.", TRIGGER_NODE_ID);

  // Reachability
  const reachable = new Set<string>();
  const stack = [TRIGGER_NODE_ID];
  while (stack.length) {
    const id = stack.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const t of out.get(id)?.values() ?? []) stack.push(t);
  }
  for (const n of def.nodes)
    if (!reachable.has(n.id)) warn("UNREACHABLE", "This step is never reached.", n.id);

  // Exits that must be connected, and step-specific rules
  const saved = new Map<string, string>(); // answer name → node id
  for (const n of def.nodes) {
    const c = configs.get(n.id);
    if (!c) continue;
    const wired = out.get(n.id) ?? new Map();
    if (n.type === "ask_question") {
      const q = c as AskQuestionConfig;
      if (!wired.has("no_reply"))
        err(
          "NO_REPLY_PATH",
          "Connect “No reply”: what happens if they never answer? (Use an End step to stop.)",
          n.id,
        );
      if (!wired.has("invalid"))
        err("INVALID_PATH", "Connect “Didn't understand”: what happens after the last retry?", n.id);
      if (q.answer.type === "buttons") {
        const opts = q.answer.options;
        const maxTitle = askLayout(opts.length) === "buttons" ? 20 : 24;
        const seen = new Set<string>();
        for (const o of opts) {
          if (o.title.length > maxTitle)
            err(
              "OPTION_TOO_LONG",
              `“${o.title}” is too long: WhatsApp allows ${maxTitle} characters here (an emoji counts as 2).`,
              n.id,
            );
          const key = o.title.trim().toLowerCase();
          if (seen.has(key)) err("OPTION_DUPLICATE", `Two options are called “${o.title}”.`, n.id);
          seen.add(key);
          if (!wired.has(`opt:${o.id}`))
            warn("OPTION_UNWIRED", `Option “${o.title}” ends the automation.`, n.id);
        }
        if (new Set(opts.map((o) => o.id)).size !== opts.length)
          err("OPTION_IDS", "Two options share an id.", n.id);
      } else if (!wired.has("next")) warn("ANSWER_UNWIRED", "Nothing happens after the answer.", n.id);
      if (saved.has(q.saveAs) && saved.get(q.saveAs) !== n.id)
        warn(
          "ANSWER_NAME_REUSED",
          `Another question also saves its answer as “${q.saveAs}”; the later one wins.`,
          n.id,
        );
      saved.set(q.saveAs, n.id);
    }
    if ((n.type === "send_message" || n.type === "send_template") && c.waitForReply) {
      if (!wired.has("no_reply"))
        err(
          "NO_REPLY_PATH",
          "Connect “No reply”: what happens if they never answer? (Use an End step to stop.)",
          n.id,
        );
      if (!wired.has("replied")) warn("REPLY_UNWIRED", "Nothing happens after they reply.", n.id);
      const saveAs = String(c.saveAs ?? "");
      if (saveAs) {
        if (saved.has(saveAs) && saved.get(saveAs) !== n.id)
          warn(
            "ANSWER_NAME_REUSED",
            `Another step also saves a reply as “${saveAs}”; the later one wins.`,
            n.id,
          );
        saved.set(saveAs, n.id);
      }
      if (n.type === "send_template")
        for (const b of (c.replyButtons ?? []) as { index: number; title: string }[])
          if (!wired.has(`btn:${b.index}`))
            warn("OPTION_UNWIRED", `Button “${b.title}” ends the automation.`, n.id);
    }
    if (n.type === "condition") {
      for (const h of ["yes", "no"])
        if (!wired.has(h))
          warn("BRANCH_UNWIRED", `The “${h === "yes" ? "Yes" : "No"}” way ends the automation.`, n.id);
      for (const r of (c as ConditionConfig).rules)
        if (
          r.kind === "contact" &&
          r.rule.field.startsWith("attr.") &&
          ctx.fields &&
          !ctx.fields.has(r.rule.field.slice(5))
        )
          warn("FIELD_MISSING", `The contact field “${r.rule.field.slice(5)}” doesn't exist.`, n.id);
    }
    if (n.type === "send_message") {
      const m = c as { text: string; media: unknown };
      if (m.media && m.text.length > 1024)
        err("CAPTION_TOO_LONG", "A caption can be at most 1,024 characters.", n.id);
    }
    if ((n.type === "add_tag" || n.type === "remove_tag") && ctx.tags && !ctx.tags.has(String(c.tagId)))
      err("TAG_MISSING", "This tag doesn't exist any more.", n.id);
    if (
      (n.type === "assign" || n.type === "handoff") &&
      c.userId &&
      ctx.assignees &&
      !ctx.assignees.has(String(c.userId))
    )
      err("ASSIGNEE_MISSING", "This team member can't be assigned chats in this branch any more.", n.id);
    if (n.type === "set_field" && ctx.fields && !ctx.fields.has(String(c.fieldKey)))
      err("FIELD_MISSING", "This contact field doesn't exist any more.", n.id);
    if (n.type === "send_template" && ctx.templates) {
      const t = ctx.templates.get(String(c.templateId));
      if (!t) err("TEMPLATE_MISSING", "This template doesn't exist on this number any more.", n.id);
      else {
        if (t.status !== "ready")
          err("TEMPLATE_NOT_READY", `“${t.name}” isn't approved by WhatsApp yet.`, n.id);
        const values = (c.values ?? {}) as Record<string, string>;
        const missing = t.variables.filter((v) => !values[v]?.trim());
        if (missing.length)
          err("TEMPLATE_VALUES", `Fill in ${missing.map((m) => `{{${m}}}`).join(", ")}.`, n.id);
      }
    }
  }

  // Variables
  for (const n of def.nodes) {
    const c = configs.get(n.id);
    if (!c) continue;
    for (const path of variablesUsed(textsOf(n.type, c).join("\n"))) {
      const [root, key] = path.split(".");
      if (!root || !(variableRoots as readonly string[]).includes(root))
        err("VARIABLE_UNKNOWN", `{{${path}}} isn't a variable Relay knows.`, n.id);
      else if (root === "answers" && (!key || !saved.has(key)))
        err("ANSWER_MISSING", `No question saves an answer called “${key ?? ""}”.`, n.id);
      else if (root === "contact" && key && !coreContactVars.has(key) && ctx.fields && !ctx.fields.has(key))
        warn("FIELD_MISSING", `The contact field “${key}” doesn't exist; {{${path}}} will be empty.`, n.id);
    }
  }

  // A loop must pause somewhere (a question or a wait), or one message would spin it to the limit.
  const pauses = (id: string) => {
    const t = nodes.get(id)?.type;
    return t === "ask_question" || t === "wait";
  };
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): string | null => {
    state.set(id, 1);
    for (const t of out.get(id)?.values() ?? []) {
      if (pauses(t)) continue;
      if (state.get(t) === 1) return t;
      if (!state.has(t)) {
        const found = visit(t);
        if (found) return found;
      }
    }
    state.set(id, 2);
    return null;
  };
  for (const n of def.nodes) {
    if (state.has(n.id) || pauses(n.id)) continue;
    const loop = visit(n.id);
    if (loop) {
      err("LOOP_WITHOUT_PAUSE", "This loop never waits: add a question or a wait inside it.", loop);
      break;
    }
  }

  for (const nodeId of windowRisks(def, out, configs))
    warn(
      "WINDOW",
      "This message may go out more than 24 hours after the customer last wrote, when WhatsApp only allows templates. It will take the “Couldn't send” way then.",
      nodeId,
    );
  return issues;
}

/** Every text a step sends or saves, for the variable check. */
function textsOf(type: string, c: Record<string, unknown>): string[] {
  if (type === "send_message" || type === "add_note") return [String(c.text ?? "")];
  if (type === "ask_question") return [String(c.text ?? ""), String(c.retryText ?? "")];
  if (type === "send_template") return Object.values((c.values ?? {}) as Record<string, string>);
  if (type === "set_field") return [String(c.value ?? "")];
  if (type === "handoff") return [String(c.note ?? "")];
  return [];
}

/**
 * Steps that send free text and could run 24 hours or more after the customer's last message.
 * Walks the graph with the longest possible "hours since they last wrote" at each step: a message
 * trigger starts at 0 (they just wrote); tag and manual triggers start unknown (∞); an answer resets it;
 * waits and unanswered questions add their time; a "window is open" condition clears it on Yes.
 */
function windowRisks(
  def: AutomationDefinition,
  out: Map<string, Map<string, string>>,
  configs: Map<string, Record<string, unknown>>,
): string[] {
  const types = new Map(def.nodes.map((n) => [n.id, n.type]));
  const start =
    def.trigger.type === "message_received" || def.trigger.type === "ad_click" ? 0 : Number.POSITIVE_INFINITY;
  const worst = new Map<string, number>();
  const queue: [string, number][] = [];
  for (const t of out.get(TRIGGER_NODE_ID)?.values() ?? []) queue.push([t, start]);
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const [id, hours] = queue.shift() as [string, number];
    const prev = worst.get(id);
    if (prev !== undefined && prev >= hours) continue;
    // A loop that keeps adding time is as bad as unknown.
    worst.set(id, prev !== undefined && hours > prev && hours > 24 * 30 ? Number.POSITIVE_INFINITY : hours);
    const c = configs.get(id);
    const type = types.get(id);
    for (const [handle, target] of out.get(id) ?? []) {
      let next = worst.get(id) as number;
      if (type === "wait" && c) {
        const w = c as WaitConfig;
        next += w.mode === "delay" ? toHours(w.amount, w.unit) : 24;
      } else if (type === "ask_question" && c) {
        if (handle === "no_reply") next += (c as AskQuestionConfig).timeoutMinutes / 60;
        else if (handle !== "failed") next = 0;
      } else if ((type === "send_message" || type === "send_template") && c?.waitForReply) {
        // They replied: the window is open again. No reply: the wait adds its time.
        if (handle === "no_reply") next += Number(c.timeoutMinutes ?? 0) / 60;
        else if (handle !== "failed") next = 0;
      } else if (type === "condition" && c && handle === "yes") {
        const cc = c as ConditionConfig;
        if (cc.match === "all" && cc.rules.some((r) => r.kind === "window_open")) next = 0;
      }
      queue.push([target, next]);
    }
  }
  return def.nodes
    .filter((n) => nodeSpec(n.type)?.sendsFreeText && (worst.get(n.id) ?? 0) >= LIMITS.windowHours)
    .map((n) => n.id);
}

const toHours = (amount: number, unit: "minutes" | "hours" | "days") =>
  unit === "minutes" ? amount / 60 : unit === "hours" ? amount : amount * 24;

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.level === "error");
