"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Progress } from "@relay/ui/ui/progress";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { inBranch } from "@/components/contacts/queries";
import { formatBytes, storageKey } from "@/components/settings/storage-settings";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError, api } from "@/lib/api";
import { mediaUrl } from "./items-view";
import { type CatalogItem, type CatalogMedia, catalogKeys, useCatalog } from "./queries";

/*
 * An item's gallery: photos, videos, audio and PDFs in the order customers see them. The starred one is
 * the main photo on cards and lists; the rest show on "More details". Files upload straight to storage
 * and are then prepared for WhatsApp (photos resized, videos converted), which shows as "Preparing".
 */

type Uploading = { key: string; name: string; progress: number; error?: string };

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,video/*,audio/*,application/pdf";

function putWithProgress(url: string, file: File, onProgress: (p: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.send(file);
  });
}

export function Gallery({ item }: { item: CatalogItem }) {
  const canManage = !!useCatalog().data?.canManage;
  const branch = useBranch().branch.id;
  const qc = useQueryClient();
  const [confirm, confirmElement] = useConfirm();
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const media = [...item.media].sort((a, b) => a.position - b.position);
  const [order, setOrder] = useState<string[] | null>(null);
  const shown = order
    ? order.map((id) => media.find((m) => m.id === id)).filter((m): m is CatalogMedia => !!m)
    : media;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const refresh = () => {
    qc.invalidateQueries({ queryKey: catalogKeys.item(branch, item.id) });
    qc.invalidateQueries({ queryKey: ["catalog", branch, "items"] });
    qc.invalidateQueries({ queryKey: storageKey });
  };
  const call = <T,>(path: string, method: string, json?: unknown) =>
    api<T>(inBranch(`/catalog/media${path}`, branch), { method, ...(json === undefined ? {} : { json }) });

  async function upload(file: File) {
    const key = `${file.name}-${file.size}-${Math.random()}`;
    const set = (patch: Partial<Uploading>) =>
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
    try {
      const { media: row, uploadUrl } = await call<{ media: CatalogMedia; uploadUrl: string | null }>(
        "/upload-url",
        "POST",
        {
          itemId: item.id,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
      );
      if (uploadUrl) {
        await putWithProgress(uploadUrl, file, (p) => set({ progress: p }));
        await call(`/${row.id}/complete`, "POST");
      } else {
        const form = new FormData();
        form.append("file", file);
        await api(inBranch(`/catalog/media/${row.id}/upload`, branch), { method: "POST", body: form });
      }
      setUploads((u) => u.filter((x) => x.key !== key));
      refresh();
    } catch (err) {
      set({ error: err instanceof ApiError ? err.message : (err as Error).message });
      refresh();
    }
  }

  function addFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) void upload(f);
  }

  async function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = shown.map((m) => m.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setOrder(next);
    try {
      await call("/reorder", "POST", { itemId: item.id, ids: next });
      refresh();
    } catch (err) {
      notify.error("Order not saved", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setOrder(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {confirmElement}
      {canManage ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
          className={`flex flex-col items-center gap-1 rounded-lg border border-dashed p-6 text-center text-sm transition-colors ${dragOver ? "border-primary bg-accent" : "hover:bg-accent"}`}
        >
          <Icon name="upload" className="text-muted-foreground" />
          <span className="font-medium">Add photos, videos, audio or a PDF</span>
          <span className="text-xs text-muted-foreground">
            Drop files here or click. Videos are converted to play on WhatsApp. Up to 20 per item.
          </span>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </button>
      ) : null}

      {uploads.length ? (
        <ul className="flex flex-col gap-2">
          {uploads.map((u) => (
            <li key={u.key} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate">{u.name}</span>
                {u.error ? (
                  <IconButton
                    icon="close"
                    size="sm"
                    label="Dismiss"
                    onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">{Math.round(u.progress * 100)}%</span>
                )}
              </span>
              {u.error ? (
                <span className="text-destructive">{u.error}</span>
              ) : (
                <Progress value={u.progress * 100} className="h-1.5" />
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {shown.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={shown.map((m) => m.id)} strategy={rectSortingStrategy}>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {shown.map((m) => (
                <MediaCard
                  key={m.id}
                  media={m}
                  canManage={canManage}
                  onPrimary={async () => {
                    await call(`/${m.id}`, "PATCH", { isPrimary: true }).catch((err) =>
                      notify.error("Not changed", {
                        description: err instanceof ApiError ? err.message : undefined,
                      }),
                    );
                    refresh();
                  }}
                  onCaption={async (caption) => {
                    await call(`/${m.id}`, "PATCH", { caption });
                    refresh();
                  }}
                  onDelete={async () => {
                    const ok = await confirm({
                      title: "Remove this file?",
                      description: "It's removed from the gallery and its space is freed.",
                      confirmLabel: "Remove",
                      tone: "danger",
                    });
                    if (!ok) return;
                    await call(`/${m.id}`, "DELETE");
                    refresh();
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      ) : !uploads.length ? (
        <p className="text-sm text-muted-foreground">
          No photos yet. Items with a photo show as a card on WhatsApp; without one they show as a line in a
          list.
        </p>
      ) : null}
    </div>
  );
}

function MediaCard({
  media,
  canManage,
  onPrimary,
  onCaption,
  onDelete,
}: {
  media: CatalogMedia;
  canManage: boolean;
  onPrimary: () => void;
  onCaption: (caption: string) => void;
  onDelete: () => void;
}) {
  const branch = useBranch().branch.id;
  const sortable = useSortable({ id: media.id, disabled: !canManage });
  const [caption, setCaption] = useState(media.caption ?? "");
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const visual = media.kind === "image" || media.kind === "video";
  return (
    <li
      ref={sortable.setNodeRef}
      style={style}
      className={`flex flex-col gap-2 rounded-lg border bg-card p-2 ${sortable.isDragging ? "z-10 shadow-lg" : ""}`}
    >
      <div
        className="relative aspect-square overflow-hidden rounded-md bg-muted"
        {...sortable.attributes}
        {...sortable.listeners}
      >
        {media.status === "ready" && visual ? (
          // biome-ignore lint/performance/noImgElement: served by our API with auth cookies
          <img
            src={mediaUrl(branch, media.id, true)}
            alt={media.caption ?? ""}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground">
            <Icon
              name={
                media.status === "processing"
                  ? "loading"
                  : media.kind === "audio"
                    ? "mic"
                    : media.kind === "document"
                      ? "file"
                      : media.kind === "video"
                        ? "video"
                        : "image"
              }
              className={media.status === "processing" ? "animate-spin" : undefined}
            />
            <span className="line-clamp-2 break-all">{media.fileName}</span>
          </span>
        )}
        {media.kind === "video" && media.status === "ready" ? (
          <span className="absolute right-1.5 bottom-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
            <Icon name="play" size="sm" />
          </span>
        ) : null}
        {media.isPrimary ? (
          <span className="absolute top-1.5 left-1.5">
            <Tag size="sm" tone="primary">
              Main
            </Tag>
          </span>
        ) : null}
      </div>
      {media.status === "processing" ? (
        <span className="text-xs text-muted-foreground">Preparing for WhatsApp…</span>
      ) : media.status === "failed" ? (
        <span className="text-xs text-destructive">{media.error ?? "Couldn't be used."}</span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {media.kind === "image"
            ? "Photo"
            : media.kind === "video"
              ? "Video"
              : media.kind === "audio"
                ? "Audio"
                : "PDF"}
          {media.sizeBytes ? ` · ${formatBytes(media.sizeBytes)}` : ""}
        </span>
      )}
      {canManage && media.status === "ready" ? (
        <TextInput
          aria-label="Caption"
          placeholder="Caption (optional)"
          value={caption}
          className="h-8 text-xs"
          onChange={(e) => setCaption(e.target.value)}
          onBlur={() => caption !== (media.caption ?? "") && onCaption(caption)}
        />
      ) : null}
      {canManage ? (
        <div className="flex items-center justify-between">
          {visual && !media.variantId && media.status === "ready" && !media.isPrimary ? (
            <IconButton icon="star" size="sm" label="Make this the main photo" onClick={onPrimary} />
          ) : (
            <span />
          )}
          <IconButton icon="delete" size="sm" label="Remove" onClick={onDelete} />
        </div>
      ) : null}
    </li>
  );
}
