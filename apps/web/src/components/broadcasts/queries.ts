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
  | {
      kind: "template";
      templateId: string;
      values: Record<string, ValueSpec>;
      variantB?: { templateId: string; values: Record<string, ValueSpec> } | null;
    }
  | { kind: "text"; text: string }
  | { kind: "email"; subject: string; html: string };

export type BroadcastSchedule = {
  startAt: string | null;
  timezone?: string;
  window: { days: number[]; from: string; to: string } | null;
  perDay: number | null;
  endBy: string | null;
  retry: { enabled: boolean; attempts: number };
};

export type FollowUp = {
  hours: number;
  who: "not_read" | "not_replied" | "not_delivered";
  templateId: string;
  values: Record<string, ValueSpec>;
};

export type AbTest = { share: number; decideAfterHours: number; metric: "read" | "replied" };

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
  heldBack: number;
  kind: "main" | "follow_up";
  parentId: string | null;
  followUp: FollowUp | null;
  test: AbTest | null;
  winner: {
    key: "A" | "B";
    rates: { A: number; B: number };
    decidedAt: string;
    by: "auto" | "manual";
  } | null;
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
  followUp: FollowUp | null;
  test: AbTest | null;
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
  plan: { date: string; weekday: number; from: string; to: string; count: number }[];
  moreDays: number;
  retryDays: number;
  rules: { frequencyCap: number | null; capped: number; skipLiveChats: boolean; inLiveChat: number };
  marketing: boolean;
};

export type RelatedBroadcast = {
  id: string;
  name: string;
  status: BroadcastStatus;
  kind: string;
  total: number;
  sent: number;
  read: number;
  replied: number;
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
        templateNames: Record<string, string>;
        retrying: { count: number; next: string | null };
        variants: { variant: string; total: number; sent: number; read: number; replied: number }[];
        followUps: RelatedBroadcast[];
        parent: RelatedBroadcast | null;
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
    winner: useMutation({
      mutationFn: ({ id, key }: { id: string; key: "A" | "B" }) =>
        api<{ broadcast: Broadcast }>(p(`/broadcasts/${id}/winner`), { method: "POST", json: { key } }),
      onSettled: refresh,
    }),
    testContacts: (id: string, q: string) =>
      api<{ contacts: { id: string; name: string | null; phone: string | null }[] }>(
        p(`/broadcasts/${id}/test-contacts?q=${encodeURIComponent(q)}`),
      ),
    test: (id: string, contactIds: string[], variant: "A" | "B" = "A") =>
      api<{ sent: string[]; problems: string[] }>(p(`/broadcasts/${id}/test`), {
        method: "POST",
        json: { contactIds, variant },
      }),
    remove: useMutation({
      mutationFn: (id: string) => api(p(`/broadcasts/${id}`), { method: "DELETE" }),
      onSettled: refresh,
    }),
  };
}

/* Business-wide broadcast rules (Settings → Broadcasts). */

export type BroadcastRules = { frequencyCap: number | null; skipLiveChats: boolean };

export function useBroadcastRules() {
  return useQuery({
    queryKey: ["settings", "broadcasts"],
    queryFn: () => api<{ rules: BroadcastRules; canEdit: boolean }>("/settings/broadcasts"),
  });
}

export function useSaveBroadcastRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: BroadcastRules) =>
      api<{ rules: BroadcastRules; canEdit: boolean }>("/settings/broadcasts", {
        method: "PUT",
        json: rules,
      }),
    onSuccess: (data) => qc.setQueryData(["settings", "broadcasts"], data),
  });
}
