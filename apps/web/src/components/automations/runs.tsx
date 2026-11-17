"use client";

import type { HistoryEntry } from "@relay/core/automations";
import { Segmented } from "@relay/ui/components/choice";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { ModalActions } from "@relay/ui/components/modal";
import { SidePanel } from "@relay/ui/components/side-panel";
import { Tag } from "@relay/ui/components/tag";
import { Button } from "@relay/ui/ui/button";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Canvas } from "./canvas";
import { type RunSummary, useRun, useRuns, useStopRun } from "./queries";
import { runStatusLabel, runStatusTone, took, when } from "./words";

const col = createDataTableColumns<RunSummary>();
const live = new Set(["queued", "running", "sleeping", "waiting"]);

/** Every run of the automation, newest first; a run opens beside the list with its path and steps. */
export function AutomationRuns({ id }: { id: string }) {
  const [filter, setFilter] = useState("all");
  const runs = useRuns(id, filter);
  const [open, setOpen] = useState<string | null>(null);

  const columns = useMemo(
    () => [
      col.display({
        id: "contact",
        header: "Contact",
        cell: ({ row }) => {
          const c = row.original.contact;
          return (
            <button
              type="button"
              className="flex flex-col text-left hover:underline"
              onClick={() => setOpen(row.original.id)}
            >
              <span className="font-medium">{c?.name ?? (c?.phone ? `+${c.phone}` : "Contact")}</span>
              {c?.phone ? <span className="text-xs text-muted-foreground">+{c.phone}</span> : null}
            </button>
          );
        },
      }),
      col.display({
        id: "startedBy",
        header: "Started by",
        cell: ({ row }) => (
          <span className="line-clamp-1 max-w-56 text-sm text-muted-foreground">
            {row.original.startedBy ?? "—"}
          </span>
        ),
      }),
      col.accessor("status", {
        header: "Status",
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <Tag size="sm" tone={runStatusTone[row.original.status] ?? "plain"}>
              {runStatusLabel[row.original.status] ?? row.original.status}
            </Tag>
            {row.original.test ? (
              <Tag size="sm" tone="primary">
                Test
              </Tag>
            ) : null}
          </span>
        ),
      }),
      col.accessor("error", {
        header: "Why it stopped",
        cell: ({ row }) => (
          <span className="line-clamp-1 max-w-72 text-xs text-muted-foreground">
            {row.original.error ?? "—"}
          </span>
        ),
      }),
      col.accessor("createdAt", {
        header: "Started",
        cell: ({ row }) => <span className="text-muted-foreground">{when(row.original.createdAt)}</span>,
      }),
      col.display({
        id: "took",
        header: "Took",
        cell: ({ row }) => (
          <span className="text-muted-foreground tabular-nums">
            {took(row.original.createdAt, row.original.finishedAt)}
          </span>
        ),
      }),
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
      <Segmented
        aria-label="Runs"
        value={filter}
        onChange={setFilter}
        className="self-start"
        options={[
          { value: "all", label: "All" },
          { value: "live", label: "Going" },
          { value: "completed", label: "Finished" },
          { value: "failed", label: "Failed" },
          { value: "cancelled", label: "Stopped" },
        ]}
      />
      <DataTable
        aria-label="Runs"
        columns={columns}
        data={runs.data ?? []}
        loading={runs.isPending}
        getRowId={(r) => r.id}
        empty={
          <EmptyState
            icon={<Icon name="automation" />}
            title="No runs yet"
            description="Runs show up here as people go through the automation. Use Test to try it in a chat."
          />
        }
      />
      <RunPanel id={id} runId={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function RunPanel({ id, runId, onClose }: { id: string; runId: string | null; onClose: () => void }) {
  const run = useRun(id, runId);
  const stop = useStopRun(id);
  const d = run.data;
  const path = (d?.run.output?.path ?? []).map((p) => p.replace(/:end$/, ""));
  // A run still going has no output yet: its path is the steps recorded so far.
  const livePath = d && !d.run.output ? stepsToPath(d.steps.map((s) => s.name)) : path;
  return (
    <SidePanel
      open={!!runId}
      onOpenChange={(o) => !o && onClose()}
      title={d ? (d.run.contact?.name ?? (d.run.contact?.phone ? `+${d.run.contact.phone}` : "Run")) : "Run"}
      description={
        d ? `${runStatusLabel[d.run.status] ?? d.run.status} · started ${when(d.run.createdAt)}` : undefined
      }
      width="lg"
      footer={
        d ? (
          <ModalActions>
            {d.run.conversationId ? (
              <Button variant="outline" asChild>
                <Link href={`/conversations?view=all&c=${d.run.conversationId}`}>Open the chat</Link>
              </Button>
            ) : null}
            {live.has(d.run.status) ? (
              <Button variant="destructive" disabled={stop.isPending} onClick={() => stop.mutate(d.run.id)}>
                Stop this run
              </Button>
            ) : null}
          </ModalActions>
        ) : null
      }
    >
      {d ? (
        <div className="flex flex-col gap-5 px-6 pb-6">
          {d.run.error ? (
            <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-destructive">
              {(d.run.error as { message?: string }).message ?? "It failed."}
            </p>
          ) : null}
          {d.run.nextWakeAt && live.has(d.run.status) && new Date(d.run.nextWakeAt).getFullYear() < 9999 ? (
            <p className="text-sm text-muted-foreground">
              Carries on {new Date(d.run.nextWakeAt).toLocaleString()} unless they reply first.
            </p>
          ) : null}
          {d.version ? (
            <div className="h-80 overflow-hidden rounded-lg border">
              <Canvas
                def={d.version.definition}
                issues={[]}
                selectedId={null}
                onSelect={() => {}}
                readOnly
                path={livePath}
              />
            </div>
          ) : null}
          <Answers history={d.history ?? []} />
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">What happened</h3>
            <Timeline history={d.history ?? []} />
          </section>
          <details className="group flex flex-col gap-1">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
              Technical steps ({d.steps.length})
            </summary>
            <ol className="mt-2 flex flex-col divide-y rounded-lg border">
              {d.steps.map((s) => (
                <li key={s.seq} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{stepLabel(s.name)}</span>
                    {s.error?.message ? (
                      <span className="text-xs text-destructive">{s.error.message}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {s.status === "waiting" ? "waiting" : when(s.startedAt)}
                    {s.attempt > 1 ? ` · try ${s.attempt}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : (
        <p className="px-6 text-sm text-muted-foreground">Loading…</p>
      )}
    </SidePanel>
  );
}

const toneClass: Record<HistoryEntry["tone"], string> = {
  normal: "text-foreground",
  muted: "text-muted-foreground",
  customer: "text-foreground font-medium",
  jump: "text-warning font-medium",
  warn: "text-warning",
  bad: "text-destructive",
};
const dotClass: Record<HistoryEntry["tone"], string> = {
  normal: "bg-primary",
  muted: "bg-border",
  customer: "bg-foreground",
  jump: "bg-warning",
  warn: "bg-warning",
  bad: "bg-destructive",
};

/** The run as a story, oldest first: started, sent, replied, tapped an earlier button, ended. */
function Timeline({ history }: { history: HistoryEntry[] }) {
  if (!history.length) return <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>;
  return (
    <ol className="relative flex flex-col gap-3 border-l pl-4">
      {history.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: entries never reorder
        <li key={i} className="relative flex items-start justify-between gap-3 text-sm">
          <span
            className={`absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-2 ring-background ${dotClass[h.tone]}`}
          />
          <span className={toneClass[h.tone]}>
            {h.text}
            {h.until ? ` until ${new Date(h.until).toLocaleString()}` : ""}
          </span>
          {h.at ? (
            <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={h.at}>
              {new Date(h.at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Every answer and worked-out value saved, in order: a later one doesn't hide the first. */
function Answers({ history }: { history: HistoryEntry[] }) {
  const byName = new Map<string, string[]>();
  for (const h of history)
    if (h.saved) byName.set(h.saved.name, [...(byName.get(h.saved.name) ?? []), h.saved.value]);
  if (!byName.size) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">Saved</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {[...byName].map(([name, values]) => (
          <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd>
              {values.at(-1)}
              {values.length > 1 ? (
                <span className="text-muted-foreground"> (before: {values.slice(0, -1).join(", ")})</span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** "ask_question:ask#1:answer0" → "Ask a question (ask) · answer". */
function stepLabel(name: string): string {
  const [type, rest = ""] = name.split(":");
  const [node = "", part = ""] = rest.split("#");
  const what = part.split(":")[1]?.replace(/\d+$/, "") ?? "";
  const words: Record<string, string> = {
    send_message: "Send message",
    send_template: "Send template",
    ask_question: "Ask a question",
    condition: "Condition",
    branch: "Branch",
    utility: "Utility",
    send_link: "Send link button",
    ask_location: "Ask for location",
    send_location: "Send location",
    wait: "Wait",
    add_tag: "Add tag",
    remove_tag: "Remove tag",
    set_field: "Set field",
    assign: "Assign",
    add_note: "Note",
    close_chat: "Close chat",
    handoff: "Hand to a human",
    hand_to_ai: "Hand to AI agent",
    route: "Route",
  };
  if (name === "release chat") return "Chat handed back";
  const parts: Record<string, string> = {
    typing: "typing…",
    pause: "pause",
    older_button: "tapped an earlier button",
  };
  return `${words[type ?? ""] ?? type} (${node})${what ? ` · ${parts[what] ?? what}` : ""}`;
}

/** Steps visited so far, from recorded step names ("type:node#visit…"), as "node" entries. */
function stepsToPath(names: string[]): string[] {
  const seen: string[] = [];
  for (const n of names) {
    const node = n.split(":")[1]?.split("#")[0];
    if (node && !seen.includes(node)) seen.push(node);
  }
  return seen;
}
