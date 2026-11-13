"use client";

import { templatePurposes } from "@relay/core/templates";
import { FilterPills } from "@relay/ui/components/choice";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { Icon } from "@relay/ui/components/icon";
import { Section } from "@relay/ui/components/section";
import { SearchInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@relay/ui/ui/empty";
import { Skeleton } from "@relay/ui/ui/skeleton";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { LibraryCards, LibraryDialog } from "./library";
import { ChannelStatus, previewLine } from "./parts";
import { type Template, useTemplateActions, useTemplates } from "./queries";

type Filter = "all" | "ready" | "in_review" | "needs_changes" | "draft";

/** Toasts when a channel finishes reviewing a template while the page is open. */
export function useReviewToasts(templates: Template[] | undefined) {
  const seen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!templates) return;
    const next = new Map<string, string>();
    for (const t of templates) for (const c of t.channels) next.set(`${t.id}:${c.channelId}`, c.status);
    const before = seen.current;
    if (before) {
      for (const t of templates)
        for (const c of t.channels) {
          const was = before.get(`${t.id}:${c.channelId}`);
          if (was !== "in_review") continue;
          if (c.status === "ready")
            notify.success(`“${t.name}” is approved`, { description: `Ready to send on ${c.channelName}.` });
          if (c.status === "needs_changes")
            notify.error(`“${t.name}” needs a change`, {
              description: c.reason ?? "Open it to see what to fix.",
            });
        }
    }
    seen.current = next;
  }, [templates]);
}

const has = (t: Template, status: string) => t.channels.some((c) => c.status === status);

export function TemplatesList() {
  const router = useRouter();
  const data = useTemplates();
  const actions = useTemplateActions();
  const [confirm, confirmElement] = useConfirm();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  useReviewToasts(data.data?.templates);

  const templates = data.data?.templates ?? [];
  const estimate = data.data?.channels.find((c) => c.limits?.reviewEstimate)?.limits?.reviewEstimate ?? null;
  const canManage = data.data?.canManage ?? false;
  const hasTemplateChannels = (data.data?.channels ?? []).some((c) => c.limits);

  const counts = {
    all: templates.length,
    ready: templates.filter((t) => has(t, "ready")).length,
    in_review: templates.filter((t) => has(t, "in_review")).length,
    needs_changes: templates.filter((t) => has(t, "needs_changes") || has(t, "paused")).length,
    draft: templates.filter((t) => !t.channels.length).length,
  };
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return templates.filter((t) => {
      if (needle && !`${t.name} ${t.content.body}`.toLowerCase().includes(needle)) return false;
      if (filter === "all") return true;
      if (filter === "draft") return !t.channels.length;
      if (filter === "needs_changes") return has(t, "needs_changes") || has(t, "paused");
      return has(t, filter);
    });
  }, [templates, q, filter]);

  async function onDelete(t: Template) {
    const ok = await confirm({
      title: `Delete “${t.name}”?`,
      description: t.channels.length
        ? "It is also removed from the channels it was published to, so nobody can send it any more. This can't be undone."
        : "This draft will be gone for good.",
      confirmLabel: "Delete template",
      tone: "danger",
    });
    if (!ok) return;
    actions.remove.mutate(t.id, {
      onSuccess: () => notify.success("Template deleted"),
      onError: (err) =>
        notify.error("Couldn't delete it", {
          description: err instanceof ApiError ? err.message : undefined,
        }),
    });
  }

  const header = (
    <Section
      title="Message templates"
      description="Saved messages your team can send any time, even when a chat has gone quiet for a while."
      actions={
        canManage && templates.length ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setLibraryOpen(true)}>
              <Icon name="sparkles" />
              Ready-made
            </Button>
            <Button size="sm" asChild>
              <Link href="/settings/templates/new">
                <Icon name="add" />
                New template
              </Link>
            </Button>
          </>
        ) : null
      }
    >
      {null}
    </Section>
  );

  if (data.isPending)
    return (
      <div className="flex flex-col gap-4">
        {header}
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );

  if (data.isError)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="alert" />
            </EmptyMedia>
            <EmptyTitle>Templates didn't load</EmptyTitle>
            <EmptyDescription>Check your connection and try again.</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={() => data.refetch()}>
            Try again
          </Button>
        </Empty>
      </div>
    );

  if (!templates.length)
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="flex flex-col gap-5 rounded-lg border bg-card p-6 sm:p-8">
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Icon name="sparkles" />
            </span>
            <h3 className="mt-2 text-lg font-semibold">Start with a ready-made message</h3>
            <p className="max-w-xl text-sm text-muted-foreground">
              Pick one that fits, change the words if you like, and send it for review. It takes a minute; the
              channel does the rest while you keep working.
            </p>
          </div>
          {canManage ? (
            <>
              <LibraryCards limit={4} onPick={(t) => router.push(`/settings/templates/new?from=${t.key}`)} />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setLibraryOpen(true)}>
                  See all ready-made messages
                </Button>
                <Button variant="ghost" asChild>
                  <Link href="/settings/templates/new">Write my own</Link>
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ask an owner or a branch manager to add templates.
            </p>
          )}
          {!hasTemplateChannels ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon name="info" size="sm" />
              Connect a channel that uses templates (such as WhatsApp) to publish them. You can write them
              now.
            </p>
          ) : null}
        </div>
        <LibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} />
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      {header}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FilterPills
          aria-label="Filter templates"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "ready", label: "Ready", count: counts.ready },
            { value: "in_review", label: "In review", count: counts.in_review },
            { value: "needs_changes", label: "Needs a change", count: counts.needs_changes },
            { value: "draft", label: "Drafts", count: counts.draft },
          ]}
        />
        <SearchInput
          size="sm"
          placeholder="Search templates"
          aria-label="Search templates"
          onValueChange={setQ}
          wrapperClassName="sm:w-60"
        />
      </div>

      {!shown.length ? (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          Nothing here{q ? ` for “${q}”` : ""}.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border bg-card">
          {shown.map((t) => (
            <li key={t.id} className="group relative flex items-start gap-4 px-4 py-3.5 hover:bg-muted/40">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <Link
                    href={`/settings/templates/${t.id}`}
                    className="truncate text-sm font-semibold outline-none after:absolute after:inset-0 focus-visible:underline"
                  >
                    {t.name}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {templatePurposes[t.purpose].label}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">
                  {previewLine(t.content, t.variables)}
                </p>
                <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
                  {t.channels.length ? (
                    t.channels.map((c) => <ChannelStatus key={c.channelId} copy={c} estimate={estimate} />)
                  ) : (
                    <span className="text-xs text-muted-foreground">Draft · not sent to any channel yet</span>
                  )}
                </div>
              </div>
              {canManage ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`More for ${t.name}`}
                      className="relative z-10"
                    >
                      <Icon name="more" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => router.push(`/settings/templates/${t.id}`)}>
                      <Icon name="edit" size="sm" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        actions.duplicate.mutate(t.id, {
                          onSuccess: (r) => router.push(`/settings/templates/${r.template.id}`),
                        })
                      }
                    >
                      <Icon name="copy" size="sm" />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => void onDelete(t)}>
                      <Icon name="delete" size="sm" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage && hasTemplateChannels ? (
        <p className="text-xs text-muted-foreground">
          Made templates somewhere else, like WhatsApp Manager?{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline"
            onClick={() =>
              actions.sync.mutate(undefined, {
                onSuccess: () =>
                  notify.success("Looking for templates on your channels…", {
                    description: "They appear here in a moment.",
                  }),
              })
            }
          >
            Bring them in
          </button>
        </p>
      ) : null}
      <LibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} />
      {confirmElement}
    </div>
  );
}
