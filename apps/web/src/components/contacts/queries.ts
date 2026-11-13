"use client";

import type {
  ContactFieldDef,
  ContactFilter,
  FieldOption,
  FieldType,
  ImportMapping,
  ImportTarget,
  ViewConfig,
} from "@relay/core/contacts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/* Shapes from /api/contacts, /api/contacts/fields, /api/tags and /api/contacts/views. */

export type Tag = {
  id: string;
  name: string;
  colour: string;
  branchId: string | null;
  channelAccountId: string | null;
};

export type SavedView = {
  id: string;
  name: string;
  config: ViewConfig;
  shared: boolean;
  ownerUserId: string | null;
};

export type ContactList = {
  id: string;
  name: string;
  kind: "static" | "smart";
  filter: ContactFilter | null;
};

export type ContactsMeta = {
  fields: (ContactFieldDef & { indexed: boolean })[];
  tags: Tag[];
  branches: { id: string; name: string }[];
  channels: { id: string; name: string; type: string }[];
  views: SavedView[];
  lists: ContactList[];
  canEdit: boolean;
  canManage: boolean;
};

export type ContactRow = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  branchId: string | null;
  tagIds: string[];
  attributes: Record<string, unknown>;
  source: string;
  /** Channels they opted out of marketing on; null means every channel. */
  optOuts: (string | null)[];
  lastMessageAt: string | null;
  createdAt: string;
  channels: { type: string; phone: string | null; username: string | null; profileName: string | null }[];
};

export type ContactPage = { contacts: ContactRow[]; total: number; page: number; pageSize: number };

export type ContactQuery = {
  filter: ContactFilter;
  sort: ViewConfig["sort"];
  q: string;
  page: number;
  pageSize: number;
  /** Only this static list's members. */
  listId?: string;
};

export const contactKeys = {
  all: ["contacts"] as const,
  meta: () => ["contacts", "meta"] as const,
  list: (q: ContactQuery) => ["contacts", "list", q] as const,
  lists: () => ["contacts", "lists"] as const,
  import: (id: string) => ["contacts", "import", id] as const,
  one: (id: string) => ["contacts", "one", id] as const,
};

export function useContactsMeta() {
  return useQuery({ queryKey: contactKeys.meta(), queryFn: () => api<ContactsMeta>("/contacts/meta") });
}

export function useContacts(q: ContactQuery) {
  return useQuery({
    queryKey: contactKeys.list(q),
    queryFn: () => api<ContactPage>("/contacts/query", { method: "POST", json: q }),
    placeholderData: keepPreviousData,
  });
}

export type ContactDetail = {
  contact: ContactRow & { updatedAt: string };
  identities: {
    id: string;
    channelType: string;
    phone: string | null;
    username: string | null;
    profileName: string | null;
  }[];
  notes: {
    id: string;
    body: string;
    createdAt: string;
    authorName: string | null;
    authorUserId: string | null;
  }[];
  lists: { id: string; name: string }[];
  conversations: { id: string; status: string; lastMessageAt: string | null; channelName: string }[];
  optOuts: { channelAccountId: string | null; source: "reply" | "manual" | "import"; createdAt: string }[];
};

export function useContact(id: string | null) {
  return useQuery({
    queryKey: contactKeys.one(id ?? ""),
    queryFn: () => api<ContactDetail>(`/contacts/${id}`),
    enabled: !!id,
  });
}

export type ContactPatch = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  branchId?: string | null;
  tagIds?: string[];
  attributes?: Record<string, unknown>;
  /** Marketing on one channel, or every channel when channelAccountId is null. */
  optOut?: { channelAccountId: string | null; optedOut: boolean };
};

export function useContactActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: contactKeys.all });
  return {
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: ContactPatch }) =>
        api(`/contacts/${id}`, { method: "PATCH", json: patch }),
      onSettled: refresh,
    }),
    create: useMutation({
      mutationFn: (body: ContactPatch) =>
        api<{ contact: ContactRow }>("/contacts", { method: "POST", json: body }),
      onSettled: refresh,
    }),
    bulk: useMutation({
      mutationFn: (body: {
        ids: string[];
        action: string;
        tagIds?: string[];
        branchId?: string | null;
        listId?: string;
        channelAccountId?: string | null;
      }) => api<{ affected: number }>("/contacts/bulk", { method: "POST", json: body }),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/contacts/${id}`, { method: "DELETE" }),
      onSettled: refresh,
    }),
    addNote: useMutation({
      mutationFn: ({ id, body }: { id: string; body: string }) =>
        api(`/contacts/${id}/notes`, { method: "POST", json: { body } }),
      onSettled: refresh,
    }),
    deleteNote: useMutation({
      mutationFn: ({ id, noteId }: { id: string; noteId: string }) =>
        api(`/contacts/${id}/notes/${noteId}`, { method: "DELETE" }),
      onSettled: refresh,
    }),
    addField: useMutation({
      mutationFn: (body: { label: string; type: FieldType; options?: FieldOption[] }) =>
        api<{ field: ContactFieldDef }>("/contacts/fields", { method: "POST", json: body }),
      onSettled: refresh,
    }),
    updateField: useMutation({
      mutationFn: ({ id, ...body }: { id: string; label?: string; options?: FieldOption[] }) =>
        api(`/contacts/fields/${id}`, { method: "PATCH", json: body }),
      onSettled: refresh,
    }),
    archiveField: useMutation({
      mutationFn: (id: string) => api(`/contacts/fields/${id}`, { method: "DELETE" }),
      onSettled: refresh,
    }),
    addTag: useMutation({
      mutationFn: (body: {
        name: string;
        colour?: string;
        branchId?: string | null;
        channelAccountId?: string | null;
      }) => api<{ tag: Tag }>("/tags", { method: "POST", json: body }),
      onSettled: refresh,
    }),
    saveView: useMutation({
      mutationFn: ({ id, ...body }: { id?: string; name: string; shared?: boolean; config: ViewConfig }) =>
        id
          ? api<{ view: SavedView }>(`/contacts/views/${id}`, { method: "PATCH", json: body })
          : api<{ view: SavedView }>("/contacts/views", { method: "POST", json: { shared: false, ...body } }),
      onSettled: refresh,
    }),
    saveList: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id?: string;
        name?: string;
        kind?: "static" | "smart";
        filter?: ContactFilter;
      }) =>
        id
          ? api<{ list: ContactList }>(`/contacts/lists/${id}`, { method: "PATCH", json: body })
          : api<{ list: ContactList }>("/contacts/lists", { method: "POST", json: body }),
      onSettled: refresh,
    }),
    deleteList: useMutation({
      mutationFn: (id: string) => api(`/contacts/lists/${id}`, { method: "DELETE" }),
      onSettled: refresh,
    }),
    deleteView: useMutation({
      mutationFn: (id: string) => api(`/contacts/views/${id}`, { method: "DELETE" }),
      onSettled: refresh,
    }),
  };
}

/* ------------------------------------------------------------------ lists */

export function useLists() {
  return useQuery({
    queryKey: contactKeys.lists(),
    queryFn: () => api<{ lists: (ContactList & { count: number })[] }>("/contacts/lists"),
  });
}

/* ------------------------------------------------------------------ import */

export type ImportRow = {
  id: string;
  fileName: string;
  sheet: string | null;
  status: "mapping" | "queued" | "running" | "done" | "failed";
  total: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: { row: number; reason: string }[];
};

export type UploadedFile = {
  import: ImportRow;
  fields: { key: string; label: string; type: FieldType }[];
  sheets: { name: string; headers: string[]; total: number; preview: unknown[][]; guesses: ImportTarget[] }[];
};

export const uploadImport = (file: File) => {
  const body = new FormData();
  body.set("file", file);
  return api<UploadedFile>("/contacts/imports", { method: "POST", body });
};

export const startImport = (
  id: string,
  body: { sheet: string; mapping: ImportMapping; onMatch: "update" | "skip" },
) => api<{ import: ImportRow }>(`/contacts/imports/${id}/start`, { method: "POST", json: body });

/** An import's progress, checked every second while it runs. */
export function useImport(id: string | null) {
  return useQuery({
    queryKey: contactKeys.import(id ?? ""),
    queryFn: () => api<{ import: ImportRow }>(`/contacts/imports/${id}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.import.status;
      return s === "done" || s === "failed" ? false : 1000;
    },
  });
}

/* ------------------------------------------------------------------ files */

/** Fetches a file from the API and hands it to the browser as a download. */
export async function download(path: string, init?: RequestInit & { json?: unknown }) {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...rest,
    headers: json === undefined ? rest.headers : { "content-type": "application/json" },
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "The download didn't work.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
