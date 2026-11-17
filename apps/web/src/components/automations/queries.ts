"use client";

import type { AutomationDefinition, HistoryEntry, Issue } from "@relay/core/automations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { api } from "@/lib/api";

/* Shapes from /api/automations (apps/api/src/modules/automations/routes.ts). */

export type AutomationStatus = "draft" | "live" | "paused" | "archived";

export type AutomationSummary = {
  id: string;
  name: string;
  description: string | null;
  channelAccountId: string | null;
  status: AutomationStatus;
  triggerType: AutomationDefinition["trigger"]["type"];
  draftRevision: number;
  liveVersionId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  runs7d?: number;
  liveRuns?: number;
  lastRunAt?: string | null;
};

export type BranchNumber = { id: string; displayName: string; displayPhone: string | null; status: string };

export type AutomationDetail = {
  automation: AutomationSummary;
  draft: AutomationDefinition;
  issues: Issue[];
  versions: { id: string; number: number; publishedAt: string; publishedBy: string | null }[];
  liveVersion: { id: string; number: number } | null;
  unpublishedChanges: boolean;
  canManage: boolean;
};

export type EditorOptions = {
  tags: { id: string; name: string; colour: string | null }[];
  fields: { key: string; label: string; type: string }[];
  users: { id: string; name: string; email?: string }[];
  templates: {
    id: string;
    name: string;
    status: string;
    body: string;
    variables: string[];
    replyButtons: { index: number; title: string }[];
  }[];
  numbers: BranchNumber[];
};

export type RunSummary = {
  id: string;
  status: string;
  test: boolean;
  versionId?: string;
  conversationId?: string;
  contact: { id: string; name: string | null; phone: string | null } | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Keyword “hi”, Earlier button “Talk to someone”, Run from chat by Priya… */
  startedBy?: string;
};

export type RunDetail = {
  run: RunSummary & {
    output: { path?: string[]; answers?: Record<string, string> } | null;
    nextWakeAt: string | null;
  };
  steps: {
    seq: number;
    kind: "step" | "sleep" | "wait";
    name: string;
    status: string;
    result: unknown;
    error: { message?: string } | null;
    attempt: number;
    startedAt: string;
    completedAt: string | null;
    wakeAt: string | null;
  }[];
  version: { number: number; definition: AutomationDefinition } | null;
  /** The run in plain words, oldest first. */
  history: HistoryEntry[];
};

export const automationKeys = {
  all: ["automations"] as const,
  list: (branch: string) => ["automations", branch, "list"] as const,
  one: (branch: string, id: string) => ["automations", branch, id] as const,
  options: (branch: string, id: string) => ["automations", branch, id, "options"] as const,
  runs: (branch: string, id: string, status: string) => ["automations", branch, id, "runs", status] as const,
  run: (branch: string, id: string, runId: string) => ["automations", branch, id, "run", runId] as const,
  chat: (branch: string, conversationId: string) => ["automations", branch, "chat", conversationId] as const,
};

const useBranchId = () => useBranch().branch.id;

export function useAutomations() {
  const branch = useBranchId();
  return useQuery({
    queryKey: automationKeys.list(branch),
    queryFn: () =>
      api<{ automations: AutomationSummary[]; numbers: BranchNumber[]; canManage: boolean }>(
        inBranch("/automations", branch),
      ),
    enabled: !!branch,
  });
}

export function useStarters() {
  const branch = useBranchId();
  return useQuery({
    queryKey: ["automations", branch, "starters"],
    queryFn: () =>
      api<{ starters: { id: string; name: string; description: string }[] }>(
        inBranch("/automations/starters", branch),
      ).then((r) => r.starters),
    enabled: !!branch,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useCreateAutomation() {
  const branch = useBranchId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; channelAccountId: string; starterId?: string; timezone?: string }) =>
      api<{ automation: AutomationSummary }>(inBranch("/automations", branch), {
        method: "POST",
        json: body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.list(branch) }),
  });
}

export function useAutomation(id: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: automationKeys.one(branch, id),
    queryFn: () => api<AutomationDetail>(inBranch(`/automations/${id}`, branch)),
    enabled: !!branch,
    refetchOnWindowFocus: false,
  });
}

export function useEditorOptions(id: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: automationKeys.options(branch, id),
    queryFn: () => api<EditorOptions>(inBranch(`/automations/${id}/options`, branch)),
    enabled: !!branch,
  });
}

export type SaveBody = {
  revision: number;
  name?: string;
  description?: string | null;
  channelAccountId?: string;
  draft?: AutomationDefinition;
};

export function useSaveAutomation(id: string) {
  const branch = useBranchId();
  return useMutation({
    mutationFn: (body: SaveBody) =>
      api<{ automation: AutomationSummary; issues: Issue[] }>(inBranch(`/automations/${id}`, branch), {
        method: "PATCH",
        json: body,
      }),
  });
}

export function usePublish(id: string) {
  const branch = useBranchId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (acknowledgeWarnings: boolean) =>
      api<{ version: { id: string; number: number }; issues: Issue[] }>(
        inBranch(`/automations/${id}/publish`, branch),
        { method: "POST", json: { acknowledgeWarnings } },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automations", branch] }),
  });
}

export function useAutomationAction(id: string) {
  const branch = useBranchId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "pause" | "resume" | "archive") =>
      api(inBranch(`/automations/${id}/${action}`, branch), { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automations", branch] }),
  });
}

export function useRestoreVersion(id: string) {
  const branch = useBranchId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (n: number) =>
      api(inBranch(`/automations/${id}/versions/${n}/restore`, branch), { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.one(branch, id) }),
  });
}

const liveStatuses = new Set(["queued", "running", "sleeping", "waiting"]);

export function useRuns(id: string, status: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: automationKeys.runs(branch, id, status),
    queryFn: () =>
      api<{ runs: RunSummary[] }>(
        inBranch(`/automations/${id}/runs${status === "all" ? "" : `?status=${status}`}`, branch),
      ).then((r) => r.runs),
    enabled: !!branch,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => liveStatuses.has(r.status)) ? 4000 : 15000),
  });
}

export function useRun(id: string, runId: string | null) {
  const branch = useBranchId();
  return useQuery({
    queryKey: automationKeys.run(branch, id, runId ?? ""),
    queryFn: () => api<RunDetail>(inBranch(`/automations/${id}/runs/${runId}`, branch)),
    enabled: !!branch && !!runId,
    refetchInterval: (q) => (q.state.data && liveStatuses.has(q.state.data.run.status) ? 3000 : false),
  });
}

export function useStopRun(id: string) {
  const branch = useBranchId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      api(inBranch(`/automations/${id}/runs/${runId}/stop`, branch), { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automations", branch, id] }),
  });
}

export function useTestChats(id: string, q: string, enabled: boolean) {
  const branch = useBranchId();
  return useQuery({
    queryKey: ["automations", branch, id, "test-chats", q],
    queryFn: () =>
      api<{
        chats: {
          conversationId: string;
          name: string | null;
          phone: string | null;
          windowExpiresAt: string | null;
          lastMessageAt: string | null;
        }[];
      }>(inBranch(`/automations/${id}/test-chats${q ? `?q=${encodeURIComponent(q)}` : ""}`, branch)).then(
        (r) => r.chats,
      ),
    enabled: !!branch && enabled,
  });
}

export function useTestRun(id: string) {
  const branch = useBranchId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) =>
      api<{ runId: string }>(inBranch(`/automations/${id}/test`, branch), {
        method: "POST",
        json: { conversationId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automations", branch, id] }),
  });
}

export type ChatAutomation = {
  current: {
    /** "ai": the AI agent holds the chat (agentId set); "automation": an automation run (automationId set). */
    kind: "automation" | "ai";
    runId: string;
    automationId: string | null;
    agentId: string | null;
    name: string;
    status: string;
    test: boolean;
  } | null;
  runnable: { id: string; name: string; description: string | null }[];
  canRun: boolean;
};

export function useChatAutomation(conversationId: string | null) {
  const branch = useBranchId();
  return useQuery({
    queryKey: automationKeys.chat(branch, conversationId ?? ""),
    queryFn: () => api<ChatAutomation>(inBranch(`/automations/chat/${conversationId}`, branch)),
    enabled: !!branch && !!conversationId,
    refetchInterval: (q) => (q.state.data?.current ? 5000 : false),
  });
}

export function useChatAutomationActions(conversationId: string) {
  const branch = useBranchId();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: automationKeys.chat(branch, conversationId) });
  return {
    run: useMutation({
      mutationFn: (automationId: string) =>
        api(inBranch(`/automations/chat/${conversationId}/run`, branch), {
          method: "POST",
          json: { automationId },
        }),
      onSuccess: done,
    }),
    stop: useMutation({
      mutationFn: () => api(inBranch(`/automations/chat/${conversationId}/stop`, branch), { method: "POST" }),
      onSuccess: done,
    }),
  };
}
