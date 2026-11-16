import { type AutomationDefinition, TRIGGER_NODE_ID } from "./definition";
import { dateOpNeeds, todayOps } from "./eval";
import {
  type AskLocationConfig,
  type AskQuestionConfig,
  askLayout,
  type BranchConfig,
  type ConditionConfig,
  type ConditionRule,
  type LocationAnswer,
  nodeSpec,
  type WaitConfig,
} from "./nodes";
import { type UtilityConfig, utilityDef } from "./utilities";
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

const coreContactVars = new Set(["name", "first_name", "phone", "email", "username", "added_on"]);

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
  const locations = new Set<string>(); // answers that are shared locations (they have parts)
  const values = new Map<string, { nodeId: string; parts: readonly string[] }>(); // utility results
  /** Rules of a Condition or a Branch path: what each kind needs besides its schema. */
  const checkRules = (rules: ConditionRule[], nodeId: string) => {
    for (const r of rules) {
      if (
        r.kind === "contact" &&
        r.rule.field.startsWith("attr.") &&
        ctx.fields &&
        !ctx.fields.has(r.rule.field.slice(5))
      )
        warn("FIELD_MISSING", `The contact field “${r.rule.field.slice(5)}” doesn't exist.`, nodeId);
      if (r.kind === "date") {
        if (r.source === "today" && !todayOps.includes(r.op))
          err("DATE_RULE", "For today, check a date, two dates or weekdays.", nodeId);
        const needs = dateOpNeeds[r.op];
        if (needs === "days" && r.days === undefined) err("DATE_RULE", "Say how many days.", nodeId);
        if (needs === "date" && !r.date) err("DATE_RULE", "Pick the date to compare with.", nodeId);
        if (needs === "range" && (!r.date || !r.to)) err("DATE_RULE", "Pick both dates.", nodeId);
        if (needs === "weekdays" && !r.weekdays?.length)
          err("DATE_RULE", "Pick at least one weekday.", nodeId);
      }
    }
  };
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
    if (n.type === "ask_location") {
      const q = c as AskLocationConfig;
      if (!wired.has("no_reply"))
        err(
          "NO_REPLY_PATH",
          "Connect “No reply”: what happens if they never answer? (Use an End step to stop.)",
          n.id,
        );
      if (!wired.has("invalid"))
        err("INVALID_PATH", "Connect “Didn't share”: what happens after the last retry?", n.id);
      if (!wired.has("next")) warn("ANSWER_UNWIRED", "Nothing happens after they share it.", n.id);
      if (saved.has(q.saveAs) && saved.get(q.saveAs) !== n.id)
        warn(
          "ANSWER_NAME_REUSED",
          `Another step also saves an answer as “${q.saveAs}”; the later one wins.`,
          n.id,
        );
      saved.set(q.saveAs, n.id);
      locations.add(q.saveAs);
    }
    if (n.type === "send_link" && c.waitForTap) {
      if (!wired.has("not_tapped"))
        err(
          "NO_TAP_PATH",
          "Connect “Not tapped”: what happens if they never open the link? (Use an End step to stop.)",
          n.id,
        );
      if (!wired.has("tapped")) warn("TAP_UNWIRED", "Nothing happens after they tap the link.", n.id);
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
      checkRules((c as ConditionConfig).rules, n.id);
    }
    if (n.type === "branch") {
      const b = c as BranchConfig;
      const names = new Set<string>();
      for (const p of b.paths) {
        const key = p.name.trim().toLowerCase();
        if (names.has(key)) err("PATH_DUPLICATE", `Two paths are called “${p.name}”.`, n.id);
        names.add(key);
        if (!wired.has(`path:${p.id}`))
          warn("BRANCH_UNWIRED", `The “${p.name}” path ends the automation.`, n.id);
        checkRules(p.rules, n.id);
      }
      if (new Set(b.paths.map((p) => p.id)).size !== b.paths.length)
        err("PATH_IDS", "Two paths share an id.", n.id);
      if (!wired.has("else")) warn("BRANCH_UNWIRED", "The “Otherwise” way ends the automation.", n.id);
    }
    if (n.type === "utility") {
      const u = c as UtilityConfig;
      const d = utilityDef(u.fn);
      const problem = d?.check?.(u as never);
      if (problem) err("UTILITY_SETTINGS", problem, n.id);
      if (d?.failLabel && !wired.has("failed"))
        warn("UTILITY_UNWIRED", `“${d.failLabel}” ends the automation.`, n.id);
      if (values.has(u.saveAs) && values.get(u.saveAs)?.nodeId !== n.id)
        warn(
          "VALUE_NAME_REUSED",
          `Another step also saves its result as “${u.saveAs}”; the later one wins.`,
          n.id,
        );
      values.set(u.saveAs, { nodeId: n.id, parts: d?.parts ?? [] });
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

  // What utilities read, and names saved twice over
  for (const n of def.nodes) {
    const c = configs.get(n.id);
    if (!c || n.type !== "utility") continue;
    const u = c as UtilityConfig;
    for (const ref of utilityDef(u.fn)?.refs(u as never) ?? []) {
      if (!ref.path) {
        err("UTILITY_INPUT", "Pick the value this works on.", n.id);
        continue;
      }
      const [root, key] = ref.path.split(".");
      if (ref.kind === "location" && !(root === "answers" && key && locations.has(key)))
        err("UTILITY_INPUT", "Pick a location shared with an “Ask for location” step.", n.id);
    }
    if (saved.has(u.saveAs))
      err(
        "VALUE_NAME_CLASH",
        `“${u.saveAs}” is already the name of an answer; give the result another name.`,
        n.id,
      );
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
      else if (root === "answers" && key && path.split(".").length > 2) {
        const part = path.split(".").slice(2).join(".");
        if (!locations.has(key))
          err("ANSWER_PART", `{{${path}}}: only a shared location has parts like .${part}.`, n.id);
        else if (!locationParts.includes(part))
          err(
            "ANSWER_PART",
            `{{${path}}}: a location has ${locationParts.map((p) => `.${p}`).join(", ")}.`,
            n.id,
          );
      } else if (root === "values" && (!key || !values.has(key)))
        err("VALUE_MISSING", `No utility saves a result called “${key ?? ""}”.`, n.id);
      else if (root === "values" && key && path.split(".").length > 2) {
        const part = path.split(".").slice(2).join(".");
        const parts = values.get(key)?.parts ?? [];
        if (!parts.includes(part))
          err(
            "VALUE_PART",
            parts.length
              ? `{{${path}}}: this result has ${parts.map((p) => `.${p}`).join(", ")}.`
              : `{{${path}}}: this result has no parts; use {{values.${key}}}.`,
            n.id,
          );
      } else if (root === "contact" && key && !coreContactVars.has(key) && ctx.fields && !ctx.fields.has(key))
        warn("FIELD_MISSING", `The contact field “${key}” doesn't exist; {{${path}}} will be empty.`, n.id);
    }
  }

  // A loop must pause somewhere (a question or a wait), or one message would spin it to the limit.
  const pauses = (id: string) => {
    const t = nodes.get(id)?.type;
    return (
      t === "ask_question" ||
      t === "ask_location" ||
      t === "wait" ||
      (t === "send_link" && !!configs.get(id)?.waitForTap)
    );
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

/** The parts of a shared location answer: {{answers.x.map_link}}… */
const locationParts: readonly string[] = [
  "latitude",
  "longitude",
  "name",
  "address",
  "map_link",
] satisfies (keyof LocationAnswer)[];

/** Every text a step sends or saves, for the variable check. */
function textsOf(type: string, c: Record<string, unknown>): string[] {
  if (type === "send_message" || type === "add_note") return [String(c.text ?? "")];
  if (type === "ask_question" || type === "ask_location")
    return [String(c.text ?? ""), String(c.retryText ?? "")];
  if (type === "send_link") return [String(c.text ?? ""), String(c.url ?? ""), String(c.footer ?? "")];
  if (type === "send_template") return Object.values((c.values ?? {}) as Record<string, string>);
  if (type === "set_field") return [String(c.value ?? "")];
  if (type === "handoff") return [String(c.note ?? "")];
  // Values a rule or a utility reads, as {{paths}}, so they're checked like any variable.
  const rulePaths = (rules: ConditionRule[]) =>
    rules.flatMap((r) =>
      r.kind === "variable" && r.name
        ? [`{{${r.name}}}`]
        : r.kind === "date" && r.source !== "today"
          ? [`{{${r.source}}}`]
          : [],
    );
  if (type === "condition") return rulePaths((c as ConditionConfig).rules);
  if (type === "branch") return (c as BranchConfig).paths.flatMap((p) => rulePaths(p.rules));
  if (type === "utility") {
    const u = c as UtilityConfig;
    const d = utilityDef(u.fn);
    if (!d) return [];
    return [
      ...d
        .refs(u as never)
        .filter((r) => r.path)
        .map((r) => `{{${r.path}}}`),
      ...d.texts(u as never),
    ];
  }
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
      } else if ((type === "ask_question" || type === "ask_location") && c) {
        if (handle === "no_reply") next += Number(c.timeoutMinutes ?? 0) / 60;
        else if (handle !== "failed") next = 0;
      } else if (type === "send_link" && c?.waitForTap) {
        // A tap doesn't reopen the window (it isn't a message), and can come any time before the timeout.
        if (handle !== "failed") next += Number(c.timeoutMinutes ?? 0) / 60;
      } else if ((type === "send_message" || type === "send_template") && c?.waitForReply) {
        // They replied: the window is open again. No reply: the wait adds its time.
        if (handle === "no_reply") next += Number(c.timeoutMinutes ?? 0) / 60;
        else if (handle !== "failed") next = 0;
      } else if (type === "condition" && c && handle === "yes") {
        const cc = c as ConditionConfig;
        if (cc.match === "all" && cc.rules.some((r) => r.kind === "window_open")) next = 0;
      } else if (type === "branch" && c && handle.startsWith("path:")) {
        const p = (c as BranchConfig).paths.find((x) => `path:${x.id}` === handle);
        if (p?.match === "all" && p.rules.some((r) => r.kind === "window_open")) next = 0;
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
