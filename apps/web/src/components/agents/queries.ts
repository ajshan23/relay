"use client";

import type { AgentSettings } from "@relay/core/agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { api } from "@/lib/api";

/** The branch's AI agent ("Mira"): settings, what it knows, trying it out, and what it costs. */

export type AgentStatus = "draft" | "live" | "paused";

export type Agent = AgentSettings & {
  id: string;
  branchId: string;
  status: AgentStatus;
  triedAt: string | null;
  updatedAt: string;
};

export type Credits = { used: number; allowance: number; left: number };

export type AgentsOverview = {
  agents: Agent[];
  knowledge: { ready: number; all: number };
  credits: Credits;
  aiReady: boolean;
  /** A voice service is set up on the server, so replies can be voice notes. */
  voiceReady: boolean;
  canManage: boolean;
  starters: { id: string; label: string; role: string; instructions: string }[];
};

export type KnowledgeKind = "text" | "qa" | "file" | "website";
export type KnowledgeSource = {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string | null;
  qa: { question: string; answer: string } | null;
  url: string | null;
  fileName: string | null;
  status: "queued" | "indexing" | "ready" | "failed";
  error: string | null;
  chunkCount: number;
  updatedAt: string;
  indexedAt: string | null;
};

export type Gap = { id: string; question: string; conversationId: string | null; createdAt: string };

export type TryOutcome =
  | { kind: "reply"; text: string; gap?: string }
  | { kind: "options"; text: string; options: { id: string; title: string }[] }
  | { kind: "handoff"; reason: string; summary: string; text?: string }
  | { kind: "close"; reason: string; text?: string }
  | { kind: "items"; itemIds: string[]; text?: string; action: "order" | "book" | "none" }
  | { kind: "media"; itemId: string; text?: string }
  | { kind: "silent" };

/** An item as Mira shows it (from the catalogue). */
export type TryCard = {
  id: string;
  title: string;
  description: string;
  priceText: string | null;
  details: string[];
  primaryMediaId: string | null;
  mediaCount: number;
  variants: { id: string; title: string; available: boolean }[];
};

export type TryResult = {
  outcome: TryOutcome;
  cards: TryCard[];
  tools: { name: string; input: unknown; ok: boolean }[];
  knowledge: { source: string; text: string }[];
  usage: {
    model: string;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    costMicros: number;
    latencyMs: number;
  }[];
};

export const agentKeys = {
  overview: (branch: string) => ["agents", branch] as const,
  knowledge: (branch: string) => ["agents", branch, "knowledge"] as const,
  gaps: (branch: string) => ["agents", branch, "gaps"] as const,
  usage: (branch: string) => ["agents", branch, "usage"] as const,
};

const useBranchId = () => useBranch().branch.id;

export function useAgents() {
  const branch = useBranchId();
  return useQuery({
    queryKey: agentKeys.overview(branch),
    queryFn: () => api<AgentsOverview>(inBranch("/agents", branch)),
    enabled: !!branch,
  });
}

export function useAgentActions() {
  const branch = useBranchId();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: agentKeys.overview(branch) });
  return {
    create: useMutation({
      mutationFn: (body: { starter?: string; name?: string }) =>
        api<{ agent: Agent }>(inBranch("/agents", branch), { method: "POST", json: body }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: Partial<AgentSettings> & { id: string }) =>
        api<{ agent: Agent }>(inBranch(`/agents/${id}`, branch), { method: "PATCH", json: body }),
      onSuccess: refresh,
    }),
    setStatus: useMutation({
      mutationFn: ({ id, status }: { id: string; status: AgentStatus }) =>
        api<{ agent: Agent }>(inBranch(`/agents/${id}/status`, branch), { method: "POST", json: { status } }),
      onSuccess: refresh,
    }),
  };
}

export function useTryAgent(agentId: string) {
  const branch = useBranchId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { messages: { from: "customer" | "agent"; text: string }[] }) =>
      api<TryResult>(inBranch(`/agents/${agentId}/try`, branch), { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.overview(branch) }),
  });
}

export function useKnowledge() {
  const branch = useBranchId();
  return useQuery({
    queryKey: agentKeys.knowledge(branch),
    queryFn: () =>
      api<{ sources: KnowledgeSource[] }>(inBranch("/agents/knowledge", branch)).then((r) => r.sources),
    enabled: !!branch,
    // While something is being read, check back every few seconds.
    refetchInterval: (q) =>
      q.state.data?.some((s) => s.status === "queued" || s.status === "indexing") ? 2500 : false,
  });
}

export type NewKnowledge =
  | { kind: "text"; title: string; body: string }
  | { kind: "qa"; question: string; answer: string }
  | { kind: "website"; url: string };

export function useKnowledgeActions() {
  const branch = useBranchId();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["agents", branch] });
  return {
    add: useMutation({
      mutationFn: (body: NewKnowledge) =>
        api(inBranch("/agents/knowledge", branch), { method: "POST", json: body }),
      onSuccess: refresh,
    }),
    upload: useMutation({
      mutationFn: (file: File) => {
        const form = new FormData();
        form.append("file", file);
        return api(inBranch("/agents/knowledge/file", branch), { method: "POST", body: form });
      },
      onSuccess: refresh,
    }),
    edit: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        title?: string;
        body?: string;
        question?: string;
        answer?: string;
      }) => api(inBranch(`/agents/knowledge/${id}`, branch), { method: "PATCH", json: body }),
      onSuccess: refresh,
    }),
    reindex: useMutation({
      mutationFn: (id: string) =>
        api(inBranch(`/agents/knowledge/${id}/reindex`, branch), { method: "POST" }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(inBranch(`/agents/knowledge/${id}`, branch), { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}

export function useGaps() {
  const branch = useBranchId();
  return useQuery({
    queryKey: agentKeys.gaps(branch),
    queryFn: () => api<{ gaps: Gap[] }>(inBranch("/agents/gaps", branch)).then((r) => r.gaps),
    enabled: !!branch,
  });
}

export function useGapActions() {
  const branch = useBranchId();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["agents", branch] });
  return {
    answer: useMutation({
      mutationFn: ({ id, question, answer }: { id: string; question: string; answer: string }) =>
        api(inBranch(`/agents/gaps/${id}/answer`, branch), { method: "POST", json: { question, answer } }),
      onSuccess: refresh,
    }),
    dismiss: useMutation({
      mutationFn: (id: string) => api(inBranch(`/agents/gaps/${id}/dismiss`, branch), { method: "POST" }),
      onSuccess: refresh,
    }),
  };
}

export function useAgentUsage() {
  const branch = useBranchId();
  return useQuery({
    queryKey: agentKeys.usage(branch),
    queryFn: () =>
      api<{ credits: Credits; month: { costUsd: number; replies: number; tries: number } }>(
        inBranch("/agents/usage", branch),
      ),
    enabled: !!branch,
  });
}
