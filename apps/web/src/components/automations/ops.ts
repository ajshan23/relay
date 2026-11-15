import {
  type AutomationDefinition,
  type AutomationNode,
  type Handle,
  type NodeType,
  nodeSpec,
  nodeSpecs,
  TRIGGER_NODE_ID,
} from "@relay/core/automations";

/*
 * Edits to a definition, as pure functions: every change in the editor goes through one of these, so
 * undo is just keeping the previous definition. Nodes get short, readable, permanent ids ("ask3").
 */

const prefix: Partial<Record<NodeType, string>> = {
  send_message: "msg",
  send_template: "tpl",
  ask_question: "ask",
  condition: "if",
  wait: "wait",
  add_tag: "tag",
  remove_tag: "untag",
  set_field: "field",
  assign: "assign",
  add_note: "note",
  close_chat: "close",
  handoff: "human",
  end: "end",
};

function newNodeId(def: AutomationDefinition, type: NodeType) {
  const p = prefix[type] ?? "step";
  let n = 1;
  const taken = new Set(def.nodes.map((x) => x.id));
  while (taken.has(`${p}${n}`)) n++;
  return `${p}${n}`;
}

const edgeId = (source: string, handle: string, target: string) => `${source}~${handle}~${target}`;

/** The exits of a step (or the trigger), from its current settings. */
export function handlesOf(node: AutomationNode | null): Handle[] {
  if (!node) return [{ id: "next", label: "Start" }];
  const spec = nodeSpec(node.type);
  if (!spec) return [];
  try {
    return spec.handles(spec.config.parse(node.config));
  } catch {
    // Unfinished settings: fall back to the exits of the defaults, plus any option exits still wired.
    return spec.handles(spec.defaults());
  }
}

/** The first exit a newly inserted step continues through. */
function mainHandle(type: NodeType, config: Record<string, unknown>): string | null {
  const spec = nodeSpec(type);
  if (!spec || spec.terminal) return null;
  const hs = spec.handles(config as never);
  return hs.find((h) => h.id === "next" || h.id === "yes")?.id ?? hs[0]?.id ?? null;
}

/** Inserts a new step on an exit; whatever that exit led to now follows the new step. */
export function insertStep(
  def: AutomationDefinition,
  source: string,
  handle: string,
  type: NodeType,
): { def: AutomationDefinition; nodeId: string } {
  const spec = nodeSpecs[type];
  const id = newNodeId(def, type);
  const config = spec.defaults() as Record<string, unknown>;
  const node: AutomationNode = { id, type, version: spec.version, config };
  const existing = def.edges.find((e) => e.source === source && e.sourceHandle === handle);
  const edges = def.edges.filter((e) => e !== existing);
  edges.push({ id: edgeId(source, handle, id), source, sourceHandle: handle, target: id });
  const main = mainHandle(type, config);
  if (existing && main)
    edges.push({
      id: edgeId(id, main, existing.target),
      source: id,
      sourceHandle: main,
      target: existing.target,
    });
  return { def: { ...def, nodes: [...def.nodes, node], edges }, nodeId: id };
}

/** Points an exit at an existing step (to merge paths or loop back). */
export function connect(
  def: AutomationDefinition,
  source: string,
  handle: string,
  target: string,
): AutomationDefinition {
  const edges = def.edges.filter((e) => !(e.source === source && e.sourceHandle === handle));
  edges.push({ id: edgeId(source, handle, target), source, sourceHandle: handle, target });
  return { ...def, edges };
}

/** Leaves an exit unconnected (the run ends there). */
export function disconnect(def: AutomationDefinition, source: string, handle: string): AutomationDefinition {
  return { ...def, edges: def.edges.filter((e) => !(e.source === source && e.sourceHandle === handle)) };
}

/**
 * Removes a step. Whatever pointed at it now points at what followed it through its main exit, so a
 * step in the middle of a line can be deleted without breaking the line.
 */
export function removeStep(def: AutomationDefinition, nodeId: string): AutomationDefinition {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return def;
  const main = mainHandle(node.type as NodeType, node.config);
  const after = main
    ? def.edges.find((e) => e.source === nodeId && e.sourceHandle === main)?.target
    : undefined;
  const edges = def.edges
    .filter((e) => e.source !== nodeId)
    .flatMap((e) => {
      if (e.target !== nodeId) return [e];
      return after && after !== e.source
        ? [{ ...e, id: edgeId(e.source, e.sourceHandle, after), target: after }]
        : [];
    });
  return { ...def, nodes: def.nodes.filter((n) => n.id !== nodeId), edges };
}

/** New settings for a step; exits that no longer exist (a removed option) lose their connection. */
export function updateConfig(
  def: AutomationDefinition,
  nodeId: string,
  config: Record<string, unknown>,
): AutomationDefinition {
  const nodes = def.nodes.map((n) => (n.id === nodeId ? { ...n, config } : n));
  const node = nodes.find((n) => n.id === nodeId) ?? null;
  const valid = new Set(handlesOf(node).map((h) => h.id));
  const edges = def.edges.filter((e) => e.source !== nodeId || valid.has(e.sourceHandle));
  return { ...def, nodes, edges };
}

export function nodeById(def: AutomationDefinition, id: string | null) {
  return id && id !== TRIGGER_NODE_ID ? (def.nodes.find((n) => n.id === id) ?? null) : null;
}
