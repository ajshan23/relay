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
import { useBranch } from "@/components/shell/branch-context";
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

export type ContactPage = {
  contacts: ContactRow[];
  /** Exact up to 10,000; past that `totalCapped` is true. */
  total: number;
  totalCapped: boolean;
  hasMore: boolean;
  page: number;
  pageSize: number;
};

export type ContactQuery = {
  filter: ContactFilter;
  sort: ViewConfig["sort"];
  q: string;
  page: number;
  pageSize: number;
  /** Only this static list's members. */
  listId?: string;
  /** The last contact of the previous page, to continue after it (keyset paging). */
  after?: string;
};

export const contactKeys = {
  all: ["contacts"] as const,
  table: (branch: string) => ["contacts", branch, "list"] as const,
  meta: (branch: string) => ["contacts", branch, "meta"] as const,
  list: (branch: string, q: ContactQuery) => ["contacts", branch, "list", q] as const,
  lists: (branch: string) => ["contacts", branch, "lists"] as const,
  import: (branch: string, id: string) => ["contacts", branch, "import", id] as const,
  one: (branch: string, id: string) => ["contacts", branch, "one", id] as const,
};

/** Contacts, lists, views and imports belong to a branch: every call names the selected one. */
export const inBranch = (path: string, branch: string) =>
  `${path}${path.includes("?") ? "&" : "?"}branch=${encodeURIComponent(branch)}`;

/** The selected branch's id, for the calls below. */
const useBranchId = () => useBranch().branch.id;

export function useContactsMeta() {
  const branch = useBranchId();
  return useQuery({
    queryKey: contactKeys.meta(branch),
    queryFn: () => api<ContactsMeta>(inBranch("/contacts/meta", branch)),
    enabled: !!branch,
  });
}

export function useContacts(q: ContactQuery) {
  const branch = useBranchId();
  return useQuery({
    queryKey: contactKeys.list(branch, q),
    queryFn: () => api<ContactPage>(inBranch("/contacts/query", branch), { method: "POST", json: q }),
    enabled: !!branch,
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
  const branch = useBranchId();
  return useQuery({
    queryKey: contactKeys.one(branch, id ?? ""),
    queryFn: () => api<ContactDetail>(inBranch(`/contacts/${id}`, branch)),
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
  const branch = useBranchId();
  const b = (path: string) => inBranch(path, branch);
  /*
   * Refresh only what a change can affect: editing one contact redraws the table and that contact,
   * not the fields, tags, views and every list count.
   */
  const refresh = (...parts: ("table" | "meta" | "lists" | "one")[]) => {
    const keys = {
      table: contactKeys.table(branch),
      meta: contactKeys.meta(branch),
      lists: contactKeys.lists(branch),
      one: ["contacts", branch, "one"],
    };
    return Promise.all(parts.map((p) => qc.invalidateQueries({ queryKey: keys[p] })));
  };
  return {
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: ContactPatch }) =>
        api(b(`/contacts/${id}`), { method: "PATCH", json: patch }),
      onSettled: () => refresh("table", "one"),
    }),
    create: useMutation({
      mutationFn: (body: ContactPatch) =>
        api<{ contact: ContactRow }>(b("/contacts"), { method: "POST", json: body }),
      onSettled: () => refresh("table", "lists"),
    }),
    bulk: useMutation({
      mutationFn: (body: {
        ids: string[];
        action: string;
        tagIds?: string[];
        branchId?: string | null;
        listId?: string;
        channelAccountId?: string | null;
      }) => api<{ affected: number }>(b("/contacts/bulk"), { method: "POST", json: body }),
      onSettled: () => refresh("table", "lists", "one"),
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(b(`/contacts/${id}`), { method: "DELETE" }),
      onSettled: () => refresh("table", "lists"),
    }),
    addNote: useMutation({
      mutationFn: ({ id, body }: { id: string; body: string }) =>
        api(b(`/contacts/${id}/notes`), { method: "POST", json: { body } }),
      onSettled: () => refresh("one"),
    }),
    deleteNote: useMutation({
      mutationFn: ({ id, noteId }: { id: string; noteId: string }) =>
        api(b(`/contacts/${id}/notes/${noteId}`), { method: "DELETE" }),
      onSettled: () => refresh("one"),
    }),
    addField: useMutation({
      mutationFn: (body: { label: string; type: FieldType; options?: FieldOption[] }) =>
        api<{ field: ContactFieldDef }>("/contacts/fields", { method: "POST", json: body }),
      onSettled: () => refresh("meta", "table"),
    }),
    updateField: useMutation({
      mutationFn: ({ id, ...body }: { id: string; label?: string; options?: FieldOption[] }) =>
        api(`/contacts/fields/${id}`, { method: "PATCH", json: body }),
      onSettled: () => refresh("meta", "table"),
    }),
    archiveField: useMutation({
      mutationFn: (id: string) => api(`/contacts/fields/${id}`, { method: "DELETE" }),
      onSettled: () => refresh("meta", "table", "lists"),
    }),
    addTag: useMutation({
      mutationFn: (body: {
        name: string;
        colour?: string;
        branchId?: string | null;
        channelAccountId?: string | null;
      }) => api<{ tag: Tag }>("/tags", { method: "POST", json: body }),
      onSettled: () => refresh("meta"),
    }),
    saveView: useMutation({
      mutationFn: ({ id, ...body }: { id?: string; name: string; shared?: boolean; config: ViewConfig }) =>
        id
          ? api<{ view: SavedView }>(b(`/contacts/views/${id}`), { method: "PATCH", json: body })
          : api<{ view: SavedView }>(b("/contacts/views"), {
              method: "POST",
              json: { shared: false, ...body },
            }),
      onSettled: () => refresh("meta"),
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
          ? api<{ list: ContactList }>(b(`/contacts/lists/${id}`), { method: "PATCH", json: body })
          : api<{ list: ContactList }>(b("/contacts/lists"), { method: "POST", json: body }),
      onSettled: () => refresh("meta", "lists", "table"),
    }),
    deleteList: useMutation({
      mutationFn: (id: string) => api(b(`/contacts/lists/${id}`), { method: "DELETE" }),
      onSettled: () => refresh("meta", "lists"),
    }),
    deleteView: useMutation({
      mutationFn: (id: string) => api(b(`/contacts/views/${id}`), { method: "DELETE" }),
      onSettled: () => refresh("meta"),
    }),
  };
}

/* ------------------------------------------------------------------ lists */

export function useLists() {
  const branch = useBranchId();
  return useQuery({
    queryKey: contactKeys.lists(branch),
    queryFn: () => api<{ lists: (ContactList & { count: number })[] }>(inBranch("/contacts/lists", branch)),
    enabled: !!branch,
  });
}

/* ------------------------------------------------------------------ import */

export type ImportRow = {
  id: string;
  fileName: string;
  sheet: string | null;
  status: "reading" | "mapping" | "queued" | "running" | "done" | "failed";
  total: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: { row: number; reason: string }[];
  /** Why the file couldn't be read. */
  readError: string | null;
  /** What's in the file, once the worker has read it (status "mapping"). */
  sheets: UploadedFile["sheets"] | null;
};

export type UploadedFile = {
  import: ImportRow;
  fields: { key: string; label: string; type: FieldType }[];
  sheets: { name: string; headers: string[]; total: number; preview: unknown[][]; guesses: ImportTarget[] }[];
};

/** Uploads a file, then waits while the worker reads it (big files take a few seconds). */
export async function uploadImport(branch: string, file: File): Promise<UploadedFile> {
  const body = new FormData();
  body.set("file", file);
  const res = await api<{ import: ImportRow; fields: UploadedFile["fields"] }>(
    inBranch("/contacts/imports", branch),
    { method: "POST", body },
  );
  let imp = res.import;
  for (let wait = 300; imp.status === "reading"; wait = Math.min(wait * 1.5, 2000)) {
    await new Promise((r) => setTimeout(r, wait));
    imp = (await api<{ import: ImportRow }>(inBranch(`/contacts/imports/${imp.id}`, branch))).import;
  }
  if (imp.status !== "mapping") throw new Error(imp.readError ?? "That file couldn't be read.");
  return { import: imp, fields: res.fields, sheets: imp.sheets ?? [] };
}

export const startImport = (
  branch: string,
  id: string,
  body: { sheet: string; mapping: ImportMapping; onMatch: "update" | "skip" },
) =>
  api<{ import: ImportRow }>(inBranch(`/contacts/imports/${id}/start`, branch), {
    method: "POST",
    json: body,
  });

/** An import's progress, checked every second while it runs. */
export function useImport(id: string | null) {
  const branch = useBranchId();
  return useQuery({
    queryKey: contactKeys.import(branch, id ?? ""),
    queryFn: () => api<{ import: ImportRow }>(inBranch(`/contacts/imports/${id}`, branch)),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.import.status;
      return s === "done" || s === "failed" ? false : 1000;
    },
  });
}

/* ------------------------------------------------------------------ files */

/**
 * Exports the current view: the worker writes the file, this waits for it and downloads it.
 * Resolves with how many contacts it has.
 */
export async function exportContacts(branch: string, body: unknown) {
  const { exportId } = await api<{ exportId: string }>(inBranch("/contacts/export", branch), {
    method: "POST",
    json: body,
  });
  const status = inBranch(`/contacts/exports/${exportId}`, branch);
  for (let wait = 300; ; wait = Math.min(wait * 1.5, 2000)) {
    await new Promise((r) => setTimeout(r, wait));
    const s = await api<{ status: "running" | "done" | "failed"; rows: number | null }>(status);
    if (s.status === "failed") throw new Error("The export didn't work. Try again.");
    if (s.status === "done") {
      // A plain navigation, not fetch: the API may answer with a redirect to the storage bucket,
      // which the browser follows and saves as a download (fetch would need CORS on the bucket).
      const link = document.createElement("a");
      link.href = `/api${inBranch(`/contacts/exports/${exportId}/file`, branch)}`;
      link.rel = "noopener";
      link.click();
      return s.rows ?? 0;
    }
  }
}

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
