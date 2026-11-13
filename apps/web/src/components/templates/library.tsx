"use client";

import type { LibraryTemplate } from "@relay/core/template-library";
import { type TemplatePurpose, templatePurposes } from "@relay/core/templates";
import { FilterPills } from "@relay/ui/components/choice";
import { Icon, type IconName } from "@relay/ui/components/icon";
import { SelectField } from "@relay/ui/components/select-field";
import { SearchInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@relay/ui/ui/tabs";
import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Highlighted, previewLine } from "./parts";
import { useLibrary } from "./queries";

/** Display names for channel types in the filter. */
const channelNames: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "SMS",
  rcs: "RCS",
};

const categories: TemplatePurpose[] = ["marketing", "updates", "login"];
const categoryIcon: Record<TemplatePurpose, IconName> = {
  marketing: "campaigns",
  updates: "notifications",
  login: "lock",
};

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

/** A compact look at the message: header, text with details filled in, footer and buttons. */
function MiniPreview({ t }: { t: LibraryTemplate }) {
  const c = t.content;
  const examples = Object.fromEntries(t.variables.map((x) => [x.name, x.example]));
  const buttonIcon = (kind: string): IconName =>
    kind === "link" ? "external" : kind === "call" ? "phone" : kind === "copy" ? "copy" : "reply";
  return (
    <div className="rounded-lg bg-muted/60 p-3">
      <div className="rounded-md rounded-tl-sm bg-card text-[13px] leading-relaxed shadow-xs">
        {c.header?.kind === "text" ? (
          <p className="px-3 pt-2.5 font-semibold">
            <Highlighted text={c.header.text} examples={examples} />
          </p>
        ) : null}
        <p className="line-clamp-5 px-3 pt-2 pb-1.5 whitespace-pre-wrap">
          <Highlighted text={c.body} examples={examples} />
        </p>
        {c.footer ? <p className="px-3 pb-2 text-[11px] text-muted-foreground">{c.footer}</p> : null}
        {c.buttons.map((b, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static library content
            key={i}
            className="flex items-center justify-center gap-1.5 border-t px-3 py-1.5 text-xs font-medium text-primary"
          >
            <Icon name={buttonIcon(b.kind)} size="xs" />
            {b.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Settings → Templates → Ready-made: every library template, filtered by channel and category.
 * "Use this" opens the editor pre-filled; nothing is sent until the business publishes it.
 */
export function LibraryPage() {
  const library = useLibrary();
  const all = library.data ?? [];
  const channels = useMemo(() => [...new Set(all.flatMap((t) => t.channels))], [all]);
  const [channel, setChannel] = useState("whatsapp");
  const [category, setCategory] = useState<TemplatePurpose>("marketing");
  const [topic, setTopic] = useState("all");
  const [q, setQ] = useState("");

  const onChannel = all.filter((t) => channel === "all" || t.channels.includes(channel));
  const inCategory = onChannel.filter((t) => t.purpose === category);
  const topics = [...new Set(inCategory.map((t) => t.topic))];
  const needle = q.trim().toLowerCase();
  const shown = inCategory.filter(
    (t) =>
      (topic === "all" || t.topic === topic) &&
      (!needle || `${t.name} ${t.summary} ${t.content.body}`.toLowerCase().includes(needle)),
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link
          href="/settings/templates"
          className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <Icon name="arrowLeft" size="sm" />
          Templates
        </Link>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Ready-made templates</h2>
            <p className="text-[13px] text-muted-foreground">
              Written to pass review on the first try. Pick one, change anything you like, then send it for
              review.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/templates/new">Write my own</Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="w-full sm:w-48">
          <SelectField
            aria-label="Channel"
            value={channel}
            onValueChange={(v) => {
              setChannel(v);
              setTopic("all");
            }}
            options={[
              { value: "all", label: "All channels" },
              ...channels.map((c) => ({ value: c, label: channelNames[c] ?? c })),
            ]}
          />
        </div>
        <SearchInput
          size="md"
          placeholder="Search ready-made templates"
          aria-label="Search ready-made templates"
          onValueChange={setQ}
          wrapperClassName="sm:ml-auto sm:w-72"
        />
      </div>

      <Tabs
        value={category}
        onValueChange={(v) => {
          setCategory(v as TemplatePurpose);
          setTopic("all");
        }}
      >
        <TabsList className="w-full justify-start sm:w-fit">
          {categories.map((c) => (
            <TabsTrigger key={c} value={c} className="gap-1.5">
              <Icon name={categoryIcon[c]} size="sm" />
              {templatePurposes[c].label}
              <span className="text-xs text-muted-foreground tabular-nums">
                {onChannel.filter((t) => t.purpose === c).length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted-foreground">{templatePurposes[category].hint}</p>
        {topics.length > 1 ? (
          <FilterPills
            aria-label="Topic"
            variant="outline"
            value={topic}
            onChange={setTopic}
            options={[
              { value: "all", label: "All", count: inCategory.length },
              ...topics.map((tp) => ({
                value: tp,
                label: tp,
                count: inCategory.filter((t) => t.topic === tp).length,
              })),
            ]}
          />
        ) : null}
      </div>

      {library.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-72" />
          ))}
        </div>
      ) : !shown.length ? (
        <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          {needle ? `Nothing matches “${q}”.` : "No ready-made templates here yet."}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((t) => (
            <article key={t.key} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{t.name}</h3>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{t.summary}</p>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t.topic}
                </span>
              </div>
              <div className="flex-1">
                <MiniPreview t={t} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={cn("flex items-center gap-1 text-xs text-muted-foreground")}>
                  {t.channels.map((c) => (
                    <span key={c} className="inline-flex items-center gap-1">
                      <Icon
                        name={c === "whatsapp" ? "whatsapp" : c === "instagram" ? "instagram" : "website"}
                        size="xs"
                      />
                      {channelNames[c] ?? c}
                    </span>
                  ))}
                </span>
                <Button size="sm" asChild>
                  <Link href={`/settings/templates/new?from=${t.key}`}>Use this</Link>
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
