"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { api } from "@/lib/api";

/** Saved answers inserted with "/" in the reply box. For the whole business or one branch. */
export type QuickReply = {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  /** null: the whole business. */
  branchId: string | null;
  updatedAt: string;
  createdBy: string | null;
};

export const quickReplyKeys = { all: (branch: string) => ["quick-replies", branch] as const };

export function useQuickReplies(enabled = true) {
  const branch = useBranch().branch.id;
  return useQuery({
    queryKey: quickReplyKeys.all(branch),
    queryFn: () =>
      api<{ quickReplies: QuickReply[] }>(inBranch("/quick-replies", branch)).then((r) => r.quickReplies),
    enabled: enabled && !!branch,
    staleTime: 60_000,
  });
}

export type QuickReplyInput = { shortcut: string; title: string; body: string; branchId: string | null };

export function useQuickReplyActions() {
  const qc = useQueryClient();
  const branch = useBranch().branch.id;
  const refresh = () => qc.invalidateQueries({ queryKey: ["quick-replies"] });
  return {
    save: useMutation({
      mutationFn: ({ id, ...body }: QuickReplyInput & { id?: string }) =>
        id
          ? api(inBranch(`/quick-replies/${id}`, branch), { method: "PATCH", json: body })
          : api(inBranch("/quick-replies", branch), { method: "POST", json: body }),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(inBranch(`/quick-replies/${id}`, branch), { method: "DELETE" }),
      onSettled: refresh,
    }),
  };
}
