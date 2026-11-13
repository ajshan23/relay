"use client";

import type {
  ContactFieldDef,
  ContactFilter,
  FieldOption,
  FieldType,
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

export type ContactsMeta = {
  fields: (ContactFieldDef & { indexed: boolean })[];
  tags: Tag[];
  branches: { id: string; name: string }[];
  channels: { id: string; name: string; type: string }[];
  views: SavedView[];
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
  marketingOptOutAt: string | null;
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
};

export const contactKeys = {
  all: ["contacts"] as const,
  meta: () => ["contacts", "meta"] as const,
  list: (q: ContactQuery) => ["contacts", "list", q] as const,
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
  marketingOptOut?: boolean;
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
    deleteView: useMutation({
      mutationFn: (id: string) => api(`/contacts/views/${id}`, { method: "DELETE" }),
      onSettled: refresh,
    }),
  };
}
