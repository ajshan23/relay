"use client";

import type { AutomationDefinition, Issue, Trigger } from "@relay/core/automations";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@relay/ui/ui/tabs";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError } from "@/lib/api";
import { Canvas } from "./canvas";
import { connect, disconnect, insertStep, removeStep, updateConfig } from "./ops";
import {
  automationKeys,
  useAutomation,
  useAutomationAction,
  useEditorOptions,
  useRestoreVersion,
  useSaveAutomation,
  useTestChats,
  useTestRun,
} from "./queries";
import { AutomationRuns } from "./runs";
import { AutomationSettings } from "./settings";
import { StepPanel } from "./step-panel";
import { StepPicker } from "./step-picker";
import { statusLabel, statusTone, when } from "./words";

/*
 * /automations/[id]: the editor (canvas + step settings), runs and settings of one automation.
 * The draft autosaves as you work; Publish checks it and freezes a version that new runs use, while
 * runs already going finish on the version they started with.
 */

type SaveState = "saved" | "saving" | "unsaved" | "error" | "stale";

export function AutomationEditor({ id }: { id: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = params.get("tab") ?? "editor";
  const detail = useAutomation(id);
  const options = useEditorOptions(id);
  const save = useSaveAutomation(id);
  const qc = useQueryClient();
  const { branch } = useBranch();

  const [def, setDef] = useState<AutomationDefinition | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ source: string; handle: string } | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [publishing, setPublishing] = useState<{ issues: Issue[]; blocked: boolean } | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const revision = useRef(0);
  const past = useRef<AutomationDefinition[]>([]);
  const future = useRef<AutomationDefinition[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<AutomationDefinition | null>(null);
  const lastPush = useRef(0);

  // Load once; after that the editor owns the draft and the server only confirms saves.
  useEffect(() => {
    if (detail.data && detail.data.automation.id === id && !def) {
      setDef(detail.data.draft);
      latest.current = detail.data.draft;
      setIssues(detail.data.issues);
      revision.current = detail.data.automation.draftRevision;
    }
  }, [detail.data, def, id]);

  const flush = useCallback(async () => {
    if (!latest.current) return;
    setState("saving");
    try {
      const res = await save.mutateAsync({ revision: revision.current, draft: latest.current });
      revision.current = res.automation.draftRevision;
      setIssues(res.issues);
      setState("saved");
      qc.invalidateQueries({ queryKey: automationKeys.one(branch.id, id) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setState("stale");
      else {
        setState("error");
        notify.error("Not saved", {
          description: err instanceof ApiError ? err.message : "Check your connection.",
        });
      }
    }
  }, [save, qc, branch.id, id]);

  const change = useCallback(
    (next: AutomationDefinition, opts: { undo?: boolean } = {}) => {
      // Typing makes many changes a second: those count as one step to undo.
      if (!opts.undo && latest.current) {
        if (Date.now() - lastPush.current > 1000) past.current = [...past.current.slice(-49), latest.current];
        lastPush.current = Date.now();
        future.current = [];
      }
      latest.current = next;
      setDef(next);
      setState("unsaved");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev || !latest.current) return;
    future.current.push(latest.current);
    change(prev, { undo: true });
  }, [change]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !latest.current) return;
    past.current.push(latest.current);
    change(next, { undo: true });
  }, [change]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]");
      if (typing || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Never leave with unsaved changes.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (state === "unsaved" || state === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  const action = useAutomationAction(id);
  const restore = useRestoreVersion(id);

  if (detail.isError)
    return (
      <EmptyState
        icon={<Icon name="automation" />}
        title="Automation not found"
        description="It may have been deleted, or it belongs to another branch."
        action={
          <Button asChild variant="outline">
            <Link href="/automations">All automations</Link>
          </Button>
        }
      />
    );
  if (!detail.data || !def)
    return <div className="p-8 text-sm text-muted-foreground">Loading the automation…</div>;

  const { automation, versions, liveVersion, canManage } = detail.data;
  const readOnly = !canManage;
  const errors = issues.filter((i) => i.level === "error");

  async function publish(acknowledgeWarnings: boolean) {
    if (timer.current) {
      clearTimeout(timer.current);
      await flush();
    }
    const res = await fetch(`/api${inBranch(`/automations/${id}/publish`, branch.id)}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acknowledgeWarnings }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      issues?: Issue[];
      message?: string;
      version?: { number: number };
    };
    if (res.ok) {
      setPublishing(null);
      notify.success(`Version ${body.version?.number ?? ""} is live`, {
        description: "New runs use it now; runs already going finish on their version.",
      });
      qc.invalidateQueries({ queryKey: ["automations", branch.id] });
      return;
    }
    if (res.status === 409 || res.status === 422)
      setPublishing({ issues: body.issues ?? [], blocked: res.status === 422 });
    else notify.error("Not published", { description: body.message });
  }

  const setTab = (t: string) => router.replace(`${pathname}${t === "editor" ? "" : `?tab=${t}`}`);

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
        <Button asChild variant="ghost" size="icon-sm" aria-label="All automations">
          <Link href="/automations">
            <Icon name="arrowLeft" />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight">{automation.name}</h1>
            <Tag size="sm" tone={statusTone[automation.status]}>
              {statusLabel[automation.status]}
              {liveVersion ? ` · v${liveVersion.number}` : ""}
            </Tag>
          </div>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {state === "saving"
              ? "Saving…"
              : state === "unsaved"
                ? "Unsaved changes"
                : state === "error"
                  ? "Not saved — will retry on the next change"
                  : state === "stale"
                    ? "Someone else changed this automation."
                    : detail.data.unpublishedChanges && liveVersion
                      ? "Saved · changes not published yet"
                      : "Saved"}
            {state === "stale" ? (
              <button
                type="button"
                className="ml-1 text-primary underline"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
            ) : null}
          </span>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="mx-auto">
          <TabsList>
            <TabsTrigger value="editor">Editor</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {tab === "editor" ? (
            <>
              <Button variant="ghost" size="icon-sm" aria-label="Undo" onClick={undo} disabled={readOnly}>
                <Icon name="arrowLeft" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Redo" onClick={redo} disabled={readOnly}>
                <Icon name="arrowRight" />
              </Button>
            </>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Icon name="history" />
                Versions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>Published versions</DropdownMenuLabel>
              {versions.length ? (
                versions.map((v) => (
                  <DropdownMenuItem
                    key={v.id}
                    disabled={readOnly}
                    onSelect={() =>
                      restore.mutate(v.number, {
                        onSuccess: () => {
                          notify.success(`Version ${v.number} copied into the draft`);
                          window.location.reload();
                        },
                      })
                    }
                    className="flex flex-col items-start"
                  >
                    <span className="text-sm">
                      Version {v.number}
                      {liveVersion?.id === v.id ? " · live" : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {when(v.publishedAt)}
                      {v.publishedBy ? ` by ${v.publishedBy}` : ""} · restore into the draft
                    </span>
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>Not published yet</DropdownMenuItem>
              )}
              {canManage && liveVersion ? (
                <>
                  <DropdownMenuSeparator />
                  {automation.status === "live" ? (
                    <DropdownMenuItem onSelect={() => action.mutate("pause")}>
                      Pause (no new runs)
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => action.mutate("resume")}>Resume</DropdownMenuItem>
                  )}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {canManage ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTestOpen(true)}
                disabled={!!errors.length}
              >
                <Icon name="play" />
                Test
              </Button>
              <Button size="sm" onClick={() => void publish(false)}>
                {liveVersion ? "Publish changes" : "Publish"}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {tab === "editor" ? (
        <div
          className={
            selected
              ? "grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_380px]"
              : "grid min-h-0 flex-1 grid-cols-1"
          }
        >
          <div className="relative min-h-[420px]">
            <Canvas
              def={def}
              issues={issues}
              options={options.data}
              selectedId={selected}
              onSelect={setSelected}
              readOnly={readOnly}
              onAdd={(source, handle) => setPicker({ source, handle })}
            />
            {!selected && !errors.length ? (
              <p className="pointer-events-none absolute top-3 left-3 max-w-sm rounded-md border bg-background/90 px-3 py-2 text-xs text-muted-foreground">
                Click a step to change it. Use <span className="font-medium text-foreground">Add step</span>{" "}
                or the + on a line to add the next one.
              </p>
            ) : null}
            {errors.length ? (
              <div className="absolute top-3 left-3 max-w-xs rounded-md border bg-background px-3 py-2 text-xs">
                <span className="font-medium text-destructive">
                  {errors.length} thing{errors.length === 1 ? "" : "s"} to fix
                </span>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {errors.slice(0, 4).map((i) => (
                    <li key={`${i.code}-${i.nodeId}-${i.message}`}>
                      <button
                        type="button"
                        className="text-left text-muted-foreground hover:text-foreground"
                        onClick={() => i.nodeId && setSelected(i.nodeId)}
                      >
                        {i.message}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          {selected ? (
            <div className="min-h-0 border-t lg:border-t-0">
              <StepPanel
                key={selected}
                def={def}
                nodeId={selected}
                issues={issues}
                options={options.data}
                readOnly={readOnly}
                onConfig={(config) => change(updateConfig(def, selected, config))}
                onTrigger={(trigger: Trigger) => change({ ...def, trigger })}
                onExit={(handle, target) =>
                  change(target ? connect(def, selected, handle, target) : disconnect(def, selected, handle))
                }
                onDelete={() => {
                  change(removeStep(def, selected));
                  setSelected(null);
                }}
                onClose={() => setSelected(null)}
              />
            </div>
          ) : null}
        </div>
      ) : tab === "runs" ? (
        <AutomationRuns id={id} />
      ) : (
        <AutomationSettings
          automation={automation}
          def={def}
          numbers={options.data?.numbers ?? []}
          readOnly={readOnly}
          onRules={(rules) => change({ ...def, rules })}
          revision={revision}
        />
      )}

      <StepPicker
        open={!!picker}
        onOpenChange={(o) => !o && setPicker(null)}
        onPick={(type) => {
          if (!picker) return;
          const { def: next, nodeId } = insertStep(def, picker.source, picker.handle, type);
          change(next);
          setSelected(nodeId);
          setPicker(null);
        }}
      />

      <Modal
        open={!!publishing}
        onOpenChange={(o) => !o && setPublishing(null)}
        title={publishing?.blocked ? "Fix these before publishing" : "Publish with these warnings?"}
        size="md"
        footer={
          <ModalActions>
            <Button variant="outline" onClick={() => setPublishing(null)}>
              {publishing?.blocked ? "Close" : "Go back"}
            </Button>
            {publishing?.blocked ? null : <Button onClick={() => void publish(true)}>Publish anyway</Button>}
          </ModalActions>
        }
      >
        <ul className="flex flex-col gap-2 px-6 pb-4">
          {(publishing?.issues ?? [])
            .filter((i) => (publishing?.blocked ? i.level === "error" : true))
            .map((i) => (
              <li key={`${i.code}-${i.nodeId}-${i.message}`} className="flex gap-2 text-sm">
                <Icon
                  name={i.level === "error" ? "alert" : "warning"}
                  size="sm"
                  className={i.level === "error" ? "mt-0.5 text-destructive" : "mt-0.5 text-warning"}
                />
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => {
                    if (i.nodeId) setSelected(i.nodeId);
                    setPublishing(null);
                  }}
                >
                  {i.message}
                </button>
              </li>
            ))}
        </ul>
      </Modal>

      <TestDialog id={id} open={testOpen} onOpenChange={setTestOpen} flush={flush} />
    </div>
  );
}

/** Runs the current draft in one chat on the automation's number, marked as a test. */
function TestDialog({
  id,
  open,
  onOpenChange,
  flush,
}: {
  id: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  flush: () => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const chats = useTestChats(id, q, open);
  const test = useTestRun(id);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Test in a chat"
      description="Runs the current draft in one chat on this number. Messages really go out, so pick your own number or a teammate's."
      size="md"
    >
      <div className="flex flex-col gap-3 px-6 pb-5">
        <TextInput
          placeholder="Search by name or number"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          leading={<Icon name="search" size="sm" />}
          autoFocus
        />
        <ul className="-mx-2 flex flex-col">
          {(chats.data ?? []).map((c) => {
            const open = !!c.windowExpiresAt && new Date(c.windowExpiresAt) > new Date();
            return (
              <li key={c.conversationId}>
                <button
                  type="button"
                  disabled={test.isPending}
                  onClick={async () => {
                    await flush();
                    test.mutate(c.conversationId, {
                      onSuccess: () => {
                        onOpenChange(false);
                        notify.success("Test started", {
                          description: "Follow it in the chat, or in Runs.",
                          action: {
                            label: "Open chat",
                            onClick: () =>
                              window.open(`/conversations?view=all&c=${c.conversationId}`, "_self"),
                          },
                        });
                      },
                      onError: (err) =>
                        notify.error("Test not started", {
                          description: err instanceof ApiError ? err.message : undefined,
                        }),
                    });
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {c.name ?? (c.phone ? `+${c.phone}` : "Contact")}
                    </span>
                    <span className="text-xs text-muted-foreground">{c.phone ? `+${c.phone}` : ""}</span>
                  </span>
                  <Tag size="sm" tone={open ? "good" : "plain"}>
                    {open ? "Can reply" : "Templates only"}
                  </Tag>
                </button>
              </li>
            );
          })}
          {chats.data && !chats.data.length ? (
            <li className="px-2 py-3 text-sm text-muted-foreground">No chats on this number match.</li>
          ) : null}
        </ul>
      </div>
    </Modal>
  );
}
