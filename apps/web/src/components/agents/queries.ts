"use client";

import type { AgentToolSave, HttpToolConfig, McpServerTool, McpToolConfig } from "@relay/core/agent-tools";
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
  | { kind: "confirm"; toolName: string; toolId: string; mcpTool?: string; input: unknown; text: string }
  | { kind: "silent" };

/** What a change in Try would have called (nothing is sent from Try). */
export type WouldSend =
  | { kind: "http"; method: string; url: string; headers: Record<string, string>; body: unknown }
  | { kind: "http"; error: string }
  | { kind: "mcp"; tool?: string; input: unknown };

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
  wouldSend: WouldSend | null;
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
  tools: (branch: string, agentId: string) => ["agents", branch, "tools", agentId] as const,
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

// ------------------------------------------------------------------ the agent's own tools

export type AgentToolRow = {
  id: string;
  kind: "http" | "mcp";
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  confirm: boolean;
  config: HttpToolConfig | McpToolConfig;
  hasSecret: boolean;
  secretHint: string | null;
  lastTestOk: boolean | null;
  lastTestedAt: string | null;
  updatedAt: string;
};

export type ToolCallRow = {
  id: string;
  toolId: string | null;
  title: string | null;
  name: string;
  mode: "live" | "test";
  status: "ok" | "error" | "declined" | "not_sent";
  httpStatus: number | null;
  ms: number | null;
  error: string | null;
  conversationId: string | null;
  createdAt: string;
};

export type ToolsOverview = {
  tools: AgentToolRow[];
  calls: ToolCallRow[];
  limits: { perAgent: number; mcpAllowed: number };
  /** The server can keep keys safe (CHANNEL_SECRET_KEY is set). */
  ready: boolean;
  canManage: boolean;
};

export type ToolTestResult =
  | {
      ok: true;
      status: number;
      ms: number;
      answer: unknown;
      paths: string[];
      agentSees: unknown;
      request: { method: string; url: string; headers: Record<string, string>; body: unknown };
    }
  | {
      ok: false;
      error: string;
      status?: number | null;
      ms?: number | null;
      request?: { method: string; url: string; headers: Record<string, string>; body: unknown };
    };

export type SecretInput = { header: string; value: string } | null | undefined;

export function useTools(agentId: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: agentKeys.tools(branch, agentId),
    queryFn: () => api<ToolsOverview>(inBranch(`/agents/${agentId}/tools`, branch)),
    enabled: !!branch,
  });
}

export function useToolActions(agentId: string) {
  const branch = useBranchId();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: agentKeys.tools(branch, agentId) });
  const base = `/agents/${agentId}/tools`;
  return {
    save: useMutation({
      mutationFn: ({ id, ...body }: AgentToolSave & { id?: string }) =>
        api<{ tool: AgentToolRow }>(inBranch(id ? `${base}/${id}` : base, branch), {
          method: id ? "PUT" : "POST",
          json: body,
        }),
      onSuccess: refresh,
    }),
    setEnabled: useMutation({
      mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
        api(inBranch(`${base}/${id}/enabled`, branch), { method: "POST", json: { enabled } }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(inBranch(`${base}/${id}`, branch), { method: "DELETE" }),
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: (body: {
        config: HttpToolConfig;
        values: Record<string, string | number | boolean>;
        secret?: SecretInput;
        toolId?: string;
      }) => api<ToolTestResult>(inBranch(`${base}/test`, branch), { method: "POST", json: body }),
      onSuccess: refresh,
    }),
    listMcp: useMutation({
      mutationFn: (body: { url: string; secret?: SecretInput; toolId?: string }) =>
        api<{ ok: true; tools: McpServerTool[]; listedAt: string } | { ok: false; error: string }>(
          inBranch(`${base}/mcp`, branch),
          { method: "POST", json: body },
        ),
    }),
  };
}
