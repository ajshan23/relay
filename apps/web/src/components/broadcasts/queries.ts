"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { api } from "@/lib/api";

/* Shapes from /api/broadcasts (see apps/api/src/modules/broadcasts/routes.ts). */

export type BroadcastStatus =
  | "draft"
  | "scheduled"
  | "preparing"
  | "sending"
  | "paused"
  | "completed"
  | "stopped"
  | "failed";

export type ValueSpec =
  | { source: "static"; text: string }
  | { source: "field"; key: string; fallback?: string };

export type BroadcastContent =
  | { kind: "template"; templateId: string; values: Record<string, ValueSpec> }
  | { kind: "text"; text: string }
  | { kind: "email"; subject: string; html: string };

export type BroadcastSchedule = {
  startAt: string | null;
  timezone?: string;
  window: { days: number[]; from: string; to: string } | null;
  perDay: number | null;
  endBy: string | null;
};

export type Broadcast = {
  id: string;
  name: string;
  channelType: string;
  channelAccountId: string | null;
  content: BroadcastContent;
  audience: { listIds: string[]; excludeListIds: string[] };
  schedule: BroadcastSchedule;
  status: BroadcastStatus;
  pauseReason: string | null;
  pauseDetail: string | null;
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type BroadcastInput = {
  name: string;
  channelAccountId: string;
  content: BroadcastContent;
  audience: { listIds: string[]; excludeListIds: string[] };
  schedule: BroadcastSchedule;
};

export type Options = {
  channels: {
    id: string;
    type: string;
    name: string;
    phone: string | null;
    status: string;
    broadcast: { content: string; addressKind: string; dailyLimit: string; perSecond: number } | null;
    dailyLimit: number | null;
    quality: string | null;
  }[];
  templates: {
    id: string;
    name: string;
    purpose: string;
    language: string;
    channelAccountId: string;
    quality: string | null;
    variables: string[];
    content: { body: string; header: { kind: string; text?: string } | null; footer: string | null };
  }[];
  lists: { id: string; name: string; kind: "static" | "smart" }[];
  fields: { key: string; label: string }[];
  timezone: string;
  canManage: boolean;
};

export type Estimate = {
  total: number;
  reach: number;
  skipped: { noAddress: number; optedOut: number; duplicates: number };
  usNumbers: number;
  dailyLimit: number;
  perDay: number | null;
  sendingDays: number;
  marketing: boolean;
};

export type Recipient = {
  id: string;
  address: string;
  status: string;
  skipReason: string | null;
  error: string | null;
  errorCode: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  name: string | null;
};

export const broadcastKeys = {
  all: ["broadcasts"] as const,
  list: (branch: string, channel: string) => ["broadcasts", branch, "list", channel] as const,
  one: (branch: string, id: string) => ["broadcasts", branch, "one", id] as const,
  options: (branch: string) => ["broadcasts", branch, "options"] as const,
  recipients: (branch: string, id: string, status: string) =>
    ["broadcasts", branch, "recipients", id, status] as const,
};

const useBranchId = () => useBranch().branch.id;

/** Sending broadcasts refresh every few seconds; the rest when the page is visited. */
const live = (statuses: (BroadcastStatus | undefined)[]) =>
  statuses.some((s) => s === "sending" || s === "preparing" || s === "scheduled") ? 5_000 : false;

export function useBroadcasts(channel: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: broadcastKeys.list(branch, channel),
    queryFn: () =>
      api<{ broadcasts: Broadcast[] }>(inBranch(`/broadcasts?channel=${channel}`, branch)).then(
        (r) => r.broadcasts,
      ),
    enabled: !!branch,
    refetchInterval: (q) => live((q.state.data ?? []).map((x) => x.status)),
  });
}

export function useBroadcast(id: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: broadcastKeys.one(branch, id),
    queryFn: () =>
      api<{
        broadcast: Broadcast;
        reasons: { status: string; reason: string; n: number }[];
        template: {
          id: string;
          name: string;
          purpose: string;
          content: Options["templates"][number]["content"];
        } | null;
        canManage: boolean;
      }>(inBranch(`/broadcasts/${id}`, branch)),
    enabled: !!branch && !!id,
    refetchInterval: (q) => live([q.state.data?.broadcast.status]),
  });
}

export function useOptions() {
  const branch = useBranchId();
  return useQuery({
    queryKey: broadcastKeys.options(branch),
    queryFn: () => api<Options>(inBranch("/broadcasts/options", branch)),
    enabled: !!branch,
  });
}

export function useRecipients(id: string, status: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: broadcastKeys.recipients(branch, id, status),
    queryFn: () =>
      api<{ recipients: Recipient[]; next: string | null }>(
        inBranch(`/broadcasts/${id}/recipients${status ? `?status=${status}` : ""}`, branch),
      ),
    enabled: !!branch,
    placeholderData: keepPreviousData,
  });
}

export function useBroadcastActions() {
  const qc = useQueryClient();
  const branch = useBranchId();
  const p = (path: string) => inBranch(path, branch);
  const refresh = () => qc.invalidateQueries({ queryKey: broadcastKeys.all });
  return {
    save: useMutation({
      mutationFn: ({ id, ...body }: BroadcastInput & { id?: string }) =>
        id
          ? api<{ broadcast: Broadcast }>(p(`/broadcasts/${id}`), { method: "PATCH", json: body })
          : api<{ broadcast: Broadcast }>(p("/broadcasts"), { method: "POST", json: body }),
      onSettled: refresh,
    }),
    preview: (id: string) => api<{ estimate: Estimate }>(p(`/broadcasts/${id}/preview`), { method: "POST" }),
    act: useMutation({
      mutationFn: ({ id, action }: { id: string; action: "start" | "pause" | "resume" | "stop" }) =>
        api<{ broadcast: Broadcast }>(p(`/broadcasts/${id}/${action}`), { method: "POST" }),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(p(`/broadcasts/${id}`), { method: "DELETE" }),
      onSettled: refresh,
    }),
  };
}
