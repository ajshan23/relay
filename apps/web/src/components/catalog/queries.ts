"use client";

import type { FieldType } from "@relay/core/contacts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { api } from "@/lib/api";

/*
 * The branch's catalogue: types (business-wide) with their fields, categories, items with variants
 * and gallery. Everything goes through /api/catalog?branch=.
 */

export type CatalogField = {
  id: string;
  typeId: string;
  key: string;
  label: string;
  type: FieldType;
  options: { value: string; label: string }[];
  unit: string | null;
  onVariant: boolean;
  filterable: boolean;
  required: boolean;
  position: number;
};

export type CatalogType = {
  id: string;
  name: string;
  kind: "product" | "service" | "other";
  template: string | null;
  position: number;
  fields: CatalogField[];
};

export type CatalogCategory = { id: string; name: string; parentId: string | null; position: number };

export type CatalogOverview = {
  types: CatalogType[];
  categories: CatalogCategory[];
  currency: string | null;
  counts: Partial<Record<"active" | "draft" | "archived", number>>;
  templates: { id: string; name: string; kind: CatalogType["kind"]; hint: string }[];
  canManage: boolean;
};

export type ItemRow = {
  id: string;
  title: string;
  status: "active" | "draft" | "archived";
  typeId: string;
  categoryId: string | null;
  updatedAt: string;
  variantCount: number;
  currency: string | null;
  priceText: string | null;
  stock: number | null;
  available: boolean;
  primaryMedia: { id: string; kind: string; status: string } | null;
};

export type CatalogVariant = {
  id: string;
  title: string;
  sku: string | null;
  price: number | null;
  salePrice: number | null;
  currency: string;
  options: Record<string, unknown>;
  stock: number | null;
  available: boolean;
  durationMinutes: number | null;
  bookable: boolean;
  bookingCapacity: number;
  bookingOnline: boolean;
};

export type CatalogMedia = {
  id: string;
  variantId: string | null;
  kind: "image" | "video" | "audio" | "document";
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  position: number;
  isPrimary: boolean;
  caption: string | null;
  status: "processing" | "ready" | "failed";
  error: string | null;
};

export type CatalogItem = {
  id: string;
  typeId: string;
  categoryId: string | null;
  title: string;
  description: string;
  attributes: Record<string, unknown>;
  status: ItemRow["status"];
  tags: string[];
  variants: CatalogVariant[];
  media: CatalogMedia[];
};

export type ItemInput = Omit<CatalogItem, "id" | "variants" | "media"> & {
  variants: (Omit<CatalogVariant, "id"> & { id?: string })[];
};

export type ItemFilters = { q: string; status: "" | ItemRow["status"]; typeId: string; categoryId: string };

export const catalogKeys = {
  all: ["catalog"] as const,
  overview: (branch: string) => ["catalog", branch, "overview"] as const,
  items: (branch: string, f: ItemFilters) => ["catalog", branch, "items", f] as const,
  item: (branch: string, id: string) => ["catalog", branch, "item", id] as const,
};

export function useCatalog() {
  const branch = useBranch().branch.id;
  return useQuery({
    queryKey: catalogKeys.overview(branch),
    queryFn: () => api<CatalogOverview>(inBranch("/catalog", branch)),
    enabled: !!branch,
    staleTime: 30_000,
  });
}

export function useCatalogItems(filters: ItemFilters) {
  const branch = useBranch().branch.id;
  return useInfiniteQuery({
    queryKey: catalogKeys.items(branch, filters),
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      if (pageParam) params.set("cursor", pageParam);
      return api<{ items: ItemRow[]; nextCursor: string | null }>(
        inBranch(`/catalog/items?${params.toString()}`, branch),
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!branch,
    staleTime: 10_000,
  });
}

export function useCatalogItem(id: string | null) {
  const branch = useBranch().branch.id;
  return useQuery({
    queryKey: catalogKeys.item(branch, id ?? ""),
    queryFn: () => api<{ item: CatalogItem }>(inBranch(`/catalog/items/${id}`, branch)).then((r) => r.item),
    enabled: !!branch && !!id,
    // While a gallery file is being prepared, check back.
    refetchInterval: (q) => (q.state.data?.media.some((m) => m.status === "processing") ? 2500 : false),
  });
}

export function useCatalogActions() {
  const qc = useQueryClient();
  const branch = useBranch().branch.id;
  const refresh = () => qc.invalidateQueries({ queryKey: catalogKeys.all });
  const call = <T = unknown>(path: string, method: string, json?: unknown) =>
    api<T>(inBranch(path, branch), { method, ...(json === undefined ? {} : { json }) });
  return {
    setCurrency: useMutation({
      mutationFn: (currency: string) => call("/catalog/settings", "PUT", { currency }),
      onSettled: refresh,
    }),
    createType: useMutation({
      mutationFn: (body: { name: string; kind: CatalogType["kind"]; template?: string }) =>
        call<{ type: CatalogType }>("/catalog/types", "POST", body),
      onSettled: refresh,
    }),
    updateType: useMutation({
      mutationFn: ({ id, ...body }: { id: string; name?: string; kind?: CatalogType["kind"] }) =>
        call(`/catalog/types/${id}`, "PATCH", body),
      onSettled: refresh,
    }),
    archiveType: useMutation({
      mutationFn: (id: string) => call(`/catalog/types/${id}`, "DELETE"),
      onSettled: refresh,
    }),
    addField: useMutation({
      mutationFn: ({
        typeId,
        ...body
      }: {
        typeId: string;
        label: string;
        type: FieldType;
        options: string[];
        unit?: string;
        onVariant: boolean;
        filterable: boolean;
        required: boolean;
      }) => call(`/catalog/types/${typeId}/fields`, "POST", body),
      onSettled: refresh,
    }),
    updateField: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        label?: string;
        addOptions?: string[];
        unit?: string | null;
        filterable?: boolean;
        required?: boolean;
        position?: number;
      }) => call(`/catalog/fields/${id}`, "PATCH", body),
      onSettled: refresh,
    }),
    archiveField: useMutation({
      mutationFn: (id: string) => call(`/catalog/fields/${id}`, "DELETE"),
      onSettled: refresh,
    }),
    saveCategory: useMutation({
      mutationFn: ({ id, ...body }: { id?: string; name: string; parentId: string | null }) =>
        id ? call(`/catalog/categories/${id}`, "PATCH", body) : call("/catalog/categories", "POST", body),
      onSettled: refresh,
    }),
    deleteCategory: useMutation({
      mutationFn: (id: string) => call(`/catalog/categories/${id}`, "DELETE"),
      onSettled: refresh,
    }),
    saveItem: useMutation({
      mutationFn: ({ id, input }: { id?: string; input: ItemInput }) =>
        call<{ item: { id: string; title: string } }>(
          id ? `/catalog/items/${id}` : "/catalog/items",
          id ? "PUT" : "POST",
          input,
        ),
      onSettled: refresh,
    }),
    deleteItem: useMutation({
      mutationFn: (id: string) => call(`/catalog/items/${id}`, "DELETE"),
      onSettled: refresh,
    }),
    copy: useMutation({
      mutationFn: (body: { ids: string[]; toBranchId: string }) =>
        call<{ copied: number; skusCleared: number }>("/catalog/items/copy", "POST", body),
      onSettled: refresh,
    }),
    bulk: useMutation({
      mutationFn: (body: { ids: string[]; action: "archive" | "activate" | "delete" }) =>
        call<{ changed: number }>("/catalog/items/bulk", "POST", body),
      onSettled: refresh,
    }),
  };
}

/** Category names with their parents, for pickers: "Living › Sofas". */
export function categoryLabels(categories: CatalogCategory[]) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const label = (c: CatalogCategory) => {
    const names = [c.name];
    let parent = c.parentId ? byId.get(c.parentId) : undefined;
    for (let guard = 0; parent && guard < 10; guard++) {
      names.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return names.join(" › ");
  };
  return categories
    .map((c) => ({ value: c.id, label: label(c) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export const commonCurrencies = [
  "AED",
  "INR",
  "SAR",
  "QAR",
  "KWD",
  "OMR",
  "BHD",
  "USD",
  "EUR",
  "GBP",
] as const;
