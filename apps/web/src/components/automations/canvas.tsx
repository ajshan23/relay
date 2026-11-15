"use client";

import {
  type AutomationDefinition,
  type AutomationNode,
  type Issue,
  nodeSpec,
  TRIGGER_NODE_ID,
} from "@relay/core/automations";
import { Icon, type IconName } from "@relay/ui/components/icon";
import {
  Background,
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { CARD, layout, STUB } from "./layout";
import type { EditorOptions } from "./queries";
import { triggerSummary } from "./words";

/*
 * The automation as a top-down canvas: the trigger on top, one card per step, branches side by side,
 * a "+" on every open exit and on every line to insert a step. Pan and zoom freely; nothing is dragged
 * into place, the layout is always automatic.
 */

export const stepIcons: Record<string, IconName> = {
  send_message: "message",
  send_template: "file",
  ask_question: "help",
  condition: "split",
  wait: "clock",
  add_tag: "tag",
  remove_tag: "tag",
  set_field: "edit",
  assign: "addUser",
  add_note: "compose",
  close_chat: "archive",
  handoff: "handoff",
  end: "check",
};

type CardData = {
  title: string;
  summary: string;
  icon: IconName;
  errors: number;
  warnings: number;
  selected: boolean;
  highlighted: boolean;
  dimmed: boolean;
  trigger?: boolean;
  onSelect: () => void;
};

type AddData = { label: string; onAdd: () => void; readOnly: boolean };
type EdgeData = { label: string; back: boolean; stub: boolean; highlighted: boolean; onInsert?: () => void };

function StepCard({ data }: NodeProps<Node<CardData>>) {
  return (
    <>
      {!data.trigger ? <Handle type="target" position={Position.Top} className="!opacity-0" /> : null}
      <button
        type="button"
        onClick={data.onSelect}
        style={{ width: CARD.width, height: CARD.height }}
        className={cn(
          "flex flex-col gap-1 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/60",
          data.selected && "border-primary ring-2 ring-primary/25",
          data.highlighted && !data.selected && "border-primary/70 bg-accent",
          data.dimmed && "opacity-45",
          data.trigger && "border-primary/40",
        )}
      >
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
              data.trigger ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
            )}
          >
            <Icon name={data.icon} size="sm" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{data.title}</span>
          {data.errors ? (
            <span
              className="inline-flex size-5 items-center justify-center rounded-full bg-destructive text-[11px] font-semibold text-background"
              title={`${data.errors} to fix`}
            >
              {data.errors}
            </span>
          ) : data.warnings ? (
            <Icon name="warning" size="sm" className="text-warning" label={`${data.warnings} warnings`} />
          ) : null}
        </span>
        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{data.summary}</span>
      </button>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </>
  );
}

function AddStub({ data }: NodeProps<Node<AddData>>) {
  return (
    <>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <button
        type="button"
        onClick={data.onAdd}
        disabled={data.readOnly}
        style={{ width: STUB.width, height: STUB.height }}
        className="flex items-center justify-center gap-1.5 rounded-full border border-dashed bg-background text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:pointer-events-none disabled:opacity-60"
        aria-label={`Add a step after “${data.label}”`}
      >
        {data.readOnly ? (
          "Ends"
        ) : (
          <>
            <Icon name="add" size="xs" />
            Add step
          </>
        )}
      </button>
    </>
  );
}

function FlowEdge(props: EdgeProps<Edge<EdgeData>>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const [path, lx, ly] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
    offset: data?.back ? 40 : 16,
  });
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: data?.highlighted ? "var(--primary)" : "var(--border)",
          strokeWidth: data?.highlighted ? 2.5 : 1.5,
          strokeDasharray: data?.back || data?.stub ? "5 4" : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
        >
          {data?.label ? (
            <span className="max-w-32 truncate rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
              {data.label}
            </span>
          ) : null}
          {data?.onInsert && !data.stub ? (
            <button
              type="button"
              onClick={data.onInsert}
              aria-label="Insert a step here"
              className="inline-flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-70 transition hover:border-primary hover:text-primary hover:opacity-100"
            >
              <Icon name="add" size="xs" />
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { card: StepCard, add: AddStub };
const edgeTypes = { flow: FlowEdge };

export type CanvasProps = {
  def: AutomationDefinition;
  issues: Issue[];
  options?: EditorOptions;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd?: (source: string, handle: string) => void;
  readOnly?: boolean;
  /** Steps (and exits as "node:handle") a run went through, to draw its path. */
  path?: string[];
};

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ def, issues, options, selectedId, onSelect, onAdd, readOnly, path }: CanvasProps) {
  const { fitView } = useReactFlow();
  const laid = useMemo(() => layout(def), [def]);
  const walked = useMemo(() => new Set(path ?? []), [path]);
  const visited = useMemo(
    () => new Set([TRIGGER_NODE_ID, ...(path ?? []).map((p) => p.split(":")[0])]),
    [path],
  );

  const nodes = useMemo<Node[]>(
    () =>
      laid.nodes.map((n) => {
        if (n.kind === "add")
          return {
            id: n.id,
            type: "add",
            position: { x: n.x, y: n.y },
            data: { label: n.label, readOnly: !!readOnly, onAdd: () => onAdd?.(n.source, n.handle) },
            draggable: false,
            selectable: false,
          };
        const step = n.kind === "step" ? (def.nodes.find((x) => x.id === n.id) ?? null) : null;
        const mine = issues.filter((i) => i.nodeId === n.id);
        const data: CardData = {
          title: n.kind === "trigger" ? "When" : (nodeSpec(step?.type ?? "")?.label ?? step?.type ?? "Step"),
          summary: n.kind === "trigger" ? triggerSummary(def, options) : stepSummary(step, options),
          icon: n.kind === "trigger" ? "zap" : (stepIcons[step?.type ?? ""] ?? "automation"),
          errors: mine.filter((i) => i.level === "error").length,
          warnings: mine.filter((i) => i.level === "warning").length,
          selected: selectedId === n.id,
          highlighted: !!path && visited.has(n.id),
          dimmed: !!path && !visited.has(n.id),
          trigger: n.kind === "trigger",
          onSelect: () => onSelect(n.id),
        };
        return { id: n.id, type: "card", position: { x: n.x, y: n.y }, data, draggable: false };
      }),
    [laid, def, issues, options, selectedId, onSelect, onAdd, readOnly, path, visited],
  );

  const edges = useMemo<Edge[]>(
    () =>
      laid.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "flow",
        data: {
          label: e.label,
          back: e.back,
          stub: e.stub,
          highlighted:
            walked.has(`${e.source}:${e.handle}`) || (e.source === TRIGGER_NODE_ID && !!path?.length),
          onInsert: readOnly || !onAdd ? undefined : () => onAdd(e.source, e.handle),
        } satisfies EdgeData,
      })),
    [laid, walked, readOnly, onAdd, path],
  );

  // Keep the whole automation in view when steps are added or removed.
  const shape = `${def.nodes.length}:${def.edges.length}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit only when the shape changes
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.15, maxZoom: 1, duration: 200 }), 30);
    return () => clearTimeout(t);
  }, [shape, fitView]);

  // …and when the canvas itself changes size (the settings panel opening or closing, the window).
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => fitView({ padding: 0.15, maxZoom: 1 }), 60);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [fitView]);

  return (
    <div ref={box} className="h-full w-full bg-muted/40">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        // A click handler also turns pointer events on for nodes that can't be dragged or selected.
        onNodeClick={(_, n) => {
          if (n.type === "card") onSelect(n.id);
          else if (n.type === "add") (n.data as AddData).onAdd();
        }}
        panOnScroll
        zoomOnDoubleClick={false}
      >
        <Background gap={20} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}

/** A card's one-line summary, with tag, template and team member names filled in. */
export function stepSummary(step: AutomationNode | null, options?: EditorOptions): string {
  if (!step) return "";
  const spec = nodeSpec(step.type);
  if (!spec) return "Unknown step";
  const c = step.config as Record<string, unknown>;
  if (step.type === "add_tag" || step.type === "remove_tag") {
    const tag = options?.tags.find((t) => t.id === c.tagId);
    return tag ? `${step.type === "add_tag" ? "Add" : "Remove"} “${tag.name}”` : "Pick a tag";
  }
  if (step.type === "send_template") {
    const t = options?.templates.find((x) => x.id === c.templateId);
    return t ? t.name : "Pick a template";
  }
  if (step.type === "assign" || step.type === "handoff") {
    const u = options?.users.find((x) => x.id === c.userId);
    if (step.type === "assign") return u ? `Assign to ${u.name}` : "Unassign";
    return u ? `Assign to ${u.name} and stop` : "Open for the team and stop";
  }
  if (step.type === "set_field") {
    const f = options?.fields.find((x) => x.key === c.fieldKey);
    return f ? `${f.label} = ${String(c.value ?? "")}` : "Pick a field";
  }
  try {
    return spec.summary(spec.config.parse(step.config));
  } catch {
    return spec.summary({ ...spec.defaults(), ...c } as never) || "Finish setting it up";
  }
}
