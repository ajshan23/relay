"use client";

import type { LibraryTemplate } from "@relay/core/template-library";
import { templatePurposes } from "@relay/core/templates";
import { Modal } from "@relay/ui/components/modal";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { MessagePreview, previewLine } from "./parts";
import { useLibrary } from "./queries";

const goals: LibraryTemplate["goal"][] = ["Bookings", "Payments and orders", "Keep in touch"];

/** Cards for a few ready-made messages, used on the empty Templates page. */
export function LibraryCards({ limit, onPick }: { limit?: number; onPick: (t: LibraryTemplate) => void }) {
  const library = useLibrary();
  const items = (library.data ?? []).slice(0, limit);
  if (library.isPending)
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onPick(t)}
          className="group flex flex-col gap-1.5 rounded-lg border bg-card p-4 text-left transition-colors outline-none hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="text-sm font-semibold">{t.name}</span>
          <span className="text-[13px] text-muted-foreground">{t.summary}</span>
          <span className="mt-1 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            <span className="line-clamp-2">{previewLine(t.content, t.variables)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** The whole library: pick a goal, see the message, start from it. */
export function LibraryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const library = useLibrary();
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const items = library.data ?? [];
  const current = items.find((t) => t.key === selected) ?? items[0];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Start from a ready-made message"
      description="Each one is written to pass review on the first try. You can change anything before sending it."
      size="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => router.push("/settings/templates/new")}>
            Write my own instead
          </Button>
          <Button
            disabled={!current}
            onClick={() => current && router.push(`/settings/templates/new?from=${current.key}`)}
          >
            Use this message
          </Button>
        </div>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          {goals.map((goal) => (
            <div key={goal} className="flex flex-col gap-1">
              <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{goal}</p>
              {items
                .filter((t) => t.goal === goal)
                .map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={current?.key === t.key}
                    onClick={() => setSelected(t.key)}
                    onDoubleClick={() => router.push(`/settings/templates/new?from=${t.key}`)}
                    className={cn(
                      "flex flex-col rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      current?.key === t.key ? "bg-accent" : "hover:bg-muted",
                    )}
                  >
                    <span className="text-sm font-medium">{t.name}</span>
                    <span className="text-xs text-muted-foreground">{t.summary}</span>
                  </button>
                ))}
            </div>
          ))}
        </div>
        {current ? (
          <MessagePreview
            content={current.content}
            variables={current.variables}
            caption={
              <p className="text-center text-xs text-muted-foreground">
                {templatePurposes[current.purpose].label}
              </p>
            }
          />
        ) : null}
      </div>
    </Modal>
  );
}
