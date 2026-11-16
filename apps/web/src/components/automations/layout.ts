import dagre from "@dagrejs/dagre";
import { type AutomationDefinition, TRIGGER_NODE_ID } from "@relay/core/automations";
import { handlesOf } from "./ops";

/*
 * Top-down automatic layout. Nothing is positioned by hand, so every automation reads the same way:
 * trigger at the top, each step below the one before it, branches side by side. Open exits (not
 * connected yet) get a small "add" stub so the next step is always one click away.
 */

export const CARD = { width: 264, height: 84 };
export const STUB = { width: 132, height: 36 };

export type LaidOutNode =
  | { kind: "trigger"; id: string; x: number; y: number }
  | { kind: "step"; id: string; x: number; y: number }
  | { kind: "add"; id: string; x: number; y: number; source: string; handle: string; label: string };

export type LaidOutEdge = {
  id: string;
  source: string;
  target: string;
  /** The exit it leaves through, and its label ("Yes", "No reply"…). */
  handle: string;
  label: string;
  /** Points back up the page (a loop). */
  back: boolean;
  /** An edge into an "add" stub. */
  stub: boolean;
};

/**
 * Exits not shown as "add" stubs when open: "Couldn't send" stays in the step's settings to keep things
 * calm. A utility's second exit ("No pin shared", "Not found") is an everyday outcome, so it shows.
 */
const hiddenWhenOpen = (type: string | undefined, handle: string) => handle === "failed" && type !== "utility";

export function layout(def: AutomationDefinition): { nodes: LaidOutNode[]; edges: LaidOutEdge[] } {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 56, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  g.setNode(TRIGGER_NODE_ID, { ...CARD });
  for (const n of def.nodes) g.setNode(n.id, { ...CARD });

  const edges: LaidOutEdge[] = [];
  const stubs: Extract<LaidOutNode, { kind: "add" }>[] = [];
  const all = [{ id: TRIGGER_NODE_ID, node: null }, ...def.nodes.map((n) => ({ id: n.id, node: n }))];
  for (const { id, node } of all) {
    const handles = handlesOf(node);
    for (const h of handles) {
      const e = def.edges.find((x) => x.source === id && x.sourceHandle === h.id);
      const label = id === TRIGGER_NODE_ID ? "" : handles.length > 1 ? h.label : "";
      if (e && g.hasNode(e.target)) {
        edges.push({ id: e.id, source: id, target: e.target, handle: h.id, label, back: false, stub: false });
      } else if (!hiddenWhenOpen(node?.type, h.id)) {
        const stubId = `add:${id}:${h.id}`;
        g.setNode(stubId, { ...STUB });
        stubs.push({ kind: "add", id: stubId, x: 0, y: 0, source: id, handle: h.id, label: h.label });
        edges.push({
          id: `stub:${stubId}`,
          source: id,
          target: stubId,
          handle: h.id,
          label,
          back: false,
          stub: true,
        });
      }
    }
  }

  // Loops would pull the layout upward; lay out without edges that close a cycle, then draw them back.
  // An edge to a step still on the depth-first path closes a cycle; merges of two branches don't.
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const e of edges) {
      if (e.source !== id) continue;
      const s = state.get(e.target);
      if (s === "open") e.back = true;
      else if (!s) visit(e.target);
    }
    state.set(id, "done");
  };
  visit(TRIGGER_NODE_ID);
  for (const n of def.nodes) if (!state.has(n.id)) visit(n.id);
  for (const e of edges) if (!e.back) g.setEdge(e.source, e.target, {}, e.id);

  dagre.layout(g);
  const pos = (id: string, size: { width: number; height: number }) => {
    const p = g.node(id) as { x: number; y: number } | undefined;
    return { x: (p?.x ?? 0) - size.width / 2, y: (p?.y ?? 0) - size.height / 2 };
  };
  const nodes: LaidOutNode[] = [
    { kind: "trigger", id: TRIGGER_NODE_ID, ...pos(TRIGGER_NODE_ID, CARD) },
    ...def.nodes.map((n) => ({ kind: "step" as const, id: n.id, ...pos(n.id, CARD) })),
    ...stubs.map((s) => ({ ...s, ...pos(s.id, STUB) })),
  ];
  return { nodes, edges };
}
