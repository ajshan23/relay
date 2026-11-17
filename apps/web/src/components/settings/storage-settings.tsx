"use client";

import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { Panel, Section } from "@relay/ui/components/section";
import { Tag } from "@relay/ui/components/tag";
import { Button } from "@relay/ui/ui/button";
import { Progress } from "@relay/ui/ui/progress";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";

/*
 * Settings → Usage: how much file storage the business uses against its limit (500 MB for now), and,
 * for owners and admins, the largest files so they know what to clear. Every file counts once, in all
 * branches, including files customers send; when it's full, uploads stop but customers' files are kept.
 */

export type StorageUsage = {
  usedBytes: number;
  limitBytes: number;
  warnAt: number;
  canSeeFiles: boolean;
  largest: {
    id: string;
    name: string | null;
    usedIn: "knowledge" | "agent" | "from_customers" | "sent" | "unused";
    mimeType: string | null;
    sizeBytes: number;
    createdAt: string;
  }[];
};

export const storageKey = ["settings", "storage"] as const;

export function useStorageUsage() {
  return useQuery({
    queryKey: storageKey,
    queryFn: () => api<StorageUsage>("/settings/storage"),
    staleTime: 30_000,
  });
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

const usedInWords: Record<StorageUsage["largest"][number]["usedIn"], string> = {
  knowledge: "Mira's knowledge",
  agent: "Mira's picture",
  from_customers: "Sent by a customer",
  sent: "Sent by your team",
  unused: "Not used (cleared within a week)",
};

/** "312 MB of 500 MB" with a bar. Compact for page headers; the full version for Settings. */
export function StorageMeter({ compact = false }: { compact?: boolean }) {
  const q = useStorageUsage();
  if (!q.data) return compact ? null : <Skeleton className="h-16 w-full" />;
  const { usedBytes, limitBytes, warnAt } = q.data;
  const share = limitBytes ? usedBytes / limitBytes : 0;
  const full = share >= 1;
  const warn = share >= warnAt;
  const label = `${formatBytes(usedBytes)} of ${formatBytes(limitBytes)} used`;
  if (compact)
    return (
      <div className="flex min-w-40 flex-col gap-1" title={label}>
        <span className={`text-xs ${warn ? "text-warning" : "text-muted-foreground"}`}>{label}</span>
        <Progress value={Math.min(100, share * 100)} aria-label="Storage used" className="h-1.5" />
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-2xl font-semibold tracking-tight">{formatBytes(usedBytes)}</span>
        <span className="text-sm text-muted-foreground">of {formatBytes(limitBytes)}</span>
      </div>
      <Progress value={Math.min(100, share * 100)} aria-label="Storage used" />
      {full ? (
        <p className="text-sm text-destructive">
          Storage is full. New uploads are stopped until you delete files you don't need. Files customers send
          are still kept.
        </p>
      ) : warn ? (
        <p className="text-sm text-warning">
          You've used {Math.round(share * 100)}% of your storage. Delete files you don't need to keep room for
          new ones.
        </p>
      ) : null}
    </div>
  );
}

export function StorageSettings() {
  const q = useStorageUsage();
  if (q.isError)
    return (
      <EmptyState
        icon={<Icon name="alert" />}
        title="Couldn't load your usage"
        description={q.error instanceof ApiError ? q.error.message : "Something went wrong. Try again."}
        action={<Button onClick={() => q.refetch()}>Try again</Button>}
      />
    );
  return (
    <Section
      title="Usage"
      description="File storage for the whole business, all branches together. Each file counts once, however many places use it."
    >
      <Panel padding="lg">
        <StorageMeter />
      </Panel>
      {q.data?.canSeeFiles && q.data.largest.length ? (
        <Panel padding="none" className="mt-4 overflow-hidden">
          <div className="border-b px-5 py-3 text-sm font-medium">Largest files</div>
          <ul className="divide-y">
            {q.data.largest.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <Icon name={iconFor(f.mimeType)} size="sm" className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{f.name ?? kindWord(f.mimeType)}</span>
                <Tag size="sm" tone={f.usedIn === "unused" ? "warning" : "plain"}>
                  {usedInWords[f.usedIn]}
                </Tag>
                <span className="w-20 text-right tabular-nums text-muted-foreground">
                  {formatBytes(f.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </Section>
  );
}

function iconFor(mime: string | null) {
  if (mime?.startsWith("image/")) return "image" as const;
  if (mime?.startsWith("video/")) return "video" as const;
  if (mime?.startsWith("audio/")) return "mic" as const;
  return "file" as const;
}

function kindWord(mime: string | null) {
  if (mime?.startsWith("image/")) return "Photo";
  if (mime?.startsWith("video/")) return "Video";
  if (mime?.startsWith("audio/")) return "Audio";
  return "File";
}
