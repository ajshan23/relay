"use client";

import type { LibraryTemplate } from "@relay/core/template-library";
import type {
  TemplateContent,
  TemplateLimits,
  TemplatePurpose,
  TemplateStatus,
  TemplateVariable,
} from "@relay/core/templates";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";

/*
 * Template reads and writes. Every key starts with "templates" so a live template.updated event
 * refreshes them all (see components/inbox/live.tsx).
 */

export type ChannelCopy = {
  channelId: string;
  channelName: string;
  channelType: string;
  status: TemplateStatus;
  reason: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
};

export type Template = {
  id: string;
  name: string;
  slug: string;
  language: string;
  purpose: TemplatePurpose;
  content: TemplateContent;
  variables: TemplateVariable[];
  source: "relay" | "channel";
  createdAt: string;
  updatedAt: string;
  channels: ChannelCopy[];
};

export type TemplateChannel = {
  id: string;
  name: string;
  type: string;
  phone: string | null;
  status: string;
  limits: TemplateLimits | null;
};

export type TemplatesData = { templates: Template[]; channels: TemplateChannel[]; canManage: boolean };

export type TemplateInput = {
  name: string;
  language: string;
  purpose: TemplatePurpose;
  content: TemplateContent;
  variables: TemplateVariable[];
  channelIds?: string[];
};

export const templateKeys = {
  all: ["templates"] as const,
  list: () => ["templates", "list"] as const,
  one: (id: string) => ["templates", "one", id] as const,
  library: () => ["templates", "library"] as const,
};

export function useTemplates() {
  return useQuery({ queryKey: templateKeys.list(), queryFn: () => api<TemplatesData>("/templates") });
}

export function useTemplate(id: string | null) {
  return useQuery({
    queryKey: templateKeys.one(id ?? ""),
    queryFn: () => api<{ template: Template }>(`/templates/${id}`).then((r) => r.template),
    enabled: !!id,
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
}

export function useLibrary() {
  return useQuery({
    queryKey: templateKeys.library(),
    queryFn: () => api<{ library: LibraryTemplate[] }>("/templates/library").then((r) => r.library),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** A save that could not publish still keeps the draft: the error says what to fix. */
export class NotPublished extends Error {
  constructor(
    message: string,
    readonly template: Template | null,
  ) {
    super(message);
  }
}

async function save(path: string, method: "POST" | "PATCH", body: TemplateInput) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as {
    template?: Template;
    error?: string;
    message?: string;
  } | null;
  if (res.status === 422 && json?.error === "not_published")
    throw new NotPublished(json.message ?? "Check the template.", json.template ?? null);
  if (!res.ok) throw new ApiError(res.status, json?.error ?? "request_failed", json?.message);
  return json?.template as Template;
}

export function useSaveTemplate(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TemplateInput) =>
      id ? save(`/templates/${id}`, "PATCH", body) : save("/templates", "POST", body),
    onSettled: () => qc.invalidateQueries({ queryKey: templateKeys.all }),
  });
}

export function useTemplateActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: templateKeys.all });
  return {
    duplicate: useMutation({
      mutationFn: (id: string) =>
        api<{ template: Template }>(`/templates/${id}/duplicate`, { method: "POST" }),
      onSettled: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/templates/${id}`, { method: "DELETE" }),
      onSettled: done,
    }),
    sync: useMutation({
      mutationFn: () => api<{ queued: number }>("/templates/sync", { method: "POST" }),
      onSettled: done,
    }),
  };
}

export function uploadHeaderFile(file: File) {
  const form = new FormData();
  form.set("use", "template");
  form.set("file", file);
  return api<{ upload: { id: string; kind: string; fileName: string; url: string } }>("/uploads", {
    method: "POST",
    body: form,
  }).then((r) => r.upload);
}
