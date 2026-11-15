"use client";

import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { PageHeader } from "@relay/ui/components/page-header";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@relay/ui/ui/tabs";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type AutomationStatus,
  type AutomationSummary,
  type BranchNumber,
  useAutomations,
  useCreateAutomation,
  useStarters,
} from "./queries";
import { statusLabel, statusTone, triggerLabels, when } from "./words";

const col = createDataTableColumns<AutomationSummary>();

const views: Record<string, { label: string; statuses?: AutomationStatus[] }> = {
  all: { label: "All" },
  live: { label: "Live", statuses: ["live"] },
  draft: { label: "Drafts", statuses: ["draft"] },
  paused: { label: "Paused", statuses: ["paused"] },
};

/** /automations: the branch's automations, with how often they ran this week. */
export function AutomationsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = views[params.get("view") ?? "all"] ? (params.get("view") ?? "all") : "all";
  const list = useAutomations();
  const [creating, setCreating] = useState(false);
  const numbers = list.data?.numbers ?? [];
  const statuses = views[view]?.statuses;
  const rows = (list.data?.automations ?? []).filter((a) => !statuses || statuses.includes(a.status));

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "Automation",
        cell: ({ row }) => (
          <Link href={`/automations/${row.original.id}`} className="flex min-w-0 flex-col hover:underline">
            <span className="truncate font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">
              {numbers.find((n) => n.id === row.original.channelAccountId)?.displayName ?? "No number"}
            </span>
          </Link>
        ),
      }),
      col.accessor("triggerType", {
        header: "Starts when",
        cell: ({ row }) => (
          <span className="text-muted-foreground">{triggerLabels[row.original.triggerType]}</span>
        ),
      }),
      col.accessor("status", {
        header: "Status",
        cell: ({ row }) => (
          <Tag size="sm" tone={statusTone[row.original.status]}>
            {statusLabel[row.original.status]}
          </Tag>
        ),
      }),
      col.accessor("runs7d", {
        header: "Runs (7 days)",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {(row.original.runs7d ?? 0).toLocaleString()}
            {row.original.liveRuns ? (
              <span className="ml-1.5 text-xs text-muted-foreground">{row.original.liveRuns} going</span>
            ) : null}
          </span>
        ),
      }),
      col.accessor("lastRunAt", {
        header: "Last run",
        cell: ({ row }) => <span className="text-muted-foreground">{when(row.original.lastRunAt)}</span>,
      }),
      col.accessor("updatedAt", {
        header: "Changed",
        cell: ({ row }) => <span className="text-muted-foreground">{when(row.original.updatedAt)}</span>,
      }),
    ],
    [numbers],
  );

  const newButton = list.data?.canManage ? (
    <Button size="sm" onClick={() => setCreating(true)} disabled={!numbers.length}>
      <Icon name="add" />
      New automation
    </Button>
  ) : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-12">
      <PageHeader
        title="Automations"
        description="Replies and follow-ups that run by themselves on your WhatsApp numbers."
        actions={newButton}
      />
      <div className="flex flex-col gap-4 px-5 sm:px-8">
        <Tabs
          value={view}
          onValueChange={(v) => router.replace(`${pathname}${v === "all" ? "" : `?view=${v}`}`)}
          className="self-start"
        >
          <TabsList>
            {Object.entries(views).map(([key, v]) => (
              <TabsTrigger key={key} value={key}>
                {v.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <DataTable
          aria-label="Automations"
          columns={columns}
          data={rows}
          loading={list.isPending}
          getRowId={(x) => x.id}
          empty={
            <EmptyState
              icon={<Icon name="automation" />}
              title={
                view === "all" ? "No automations yet" : `No ${views[view]?.label.toLowerCase()} automations`
              }
              description={
                numbers.length
                  ? "Greet new chats, qualify leads from ads, reply after hours: start from a ready-made one."
                  : "Connect a WhatsApp number to this branch first (Settings → Channels)."
              }
              action={newButton}
            />
          }
        />
      </div>
      <NewAutomationDialog open={creating} onOpenChange={setCreating} numbers={numbers} />
    </div>
  );
}

function NewAutomationDialog({
  open,
  onOpenChange,
  numbers,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  numbers: BranchNumber[];
}) {
  const starters = useStarters();
  const create = useCreateAutomation();
  const router = useRouter();
  const [starter, setStarter] = useState<string>("blank");
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  useEffect(() => {
    if (!number && numbers[0]) setNumber(numbers[0].id);
  }, [numbers, number]);
  const choices = [
    { id: "blank", name: "Start from scratch", description: "A trigger and nothing else." },
    ...(starters.data ?? []),
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New automation"
      size="lg"
      footer={
        <ModalActions>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !number || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  channelAccountId: number,
                  starterId: starter === "blank" ? undefined : starter,
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
                {
                  onSuccess: (res) => router.push(`/automations/${res.automation.id}`),
                  onError: (err) =>
                    notify.error("Not created", {
                      description: err instanceof ApiError ? err.message : undefined,
                    }),
                },
              )
            }
          >
            Create
          </Button>
        </ModalActions>
      }
    >
      <div className="flex flex-col gap-4 px-6 pb-5">
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Start from">
          {choices.map((c) => (
            // biome-ignore lint/a11y/useSemanticElements: cards with a title and a description, acting as a radio group
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={starter === c.id}
              onClick={() => {
                setStarter(c.id);
                if (!name || choices.some((x) => x.name === name)) setName(c.id === "blank" ? "" : c.name);
              }}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:border-primary/60",
                starter === c.id && "border-primary ring-2 ring-primary/20",
              )}
            >
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs text-muted-foreground">{c.description}</span>
            </button>
          ))}
        </div>
        <Field label="Name">
          <TextInput
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="Welcome menu"
          />
        </Field>
        <Field label="WhatsApp number" hint="It listens and replies on this number.">
          <SelectField
            value={number}
            onValueChange={setNumber}
            options={numbers.map((n) => ({
              value: n.id,
              label: `${n.displayName}${n.displayPhone ? ` · ${n.displayPhone}` : ""}`,
            }))}
          />
        </Field>
      </div>
    </Modal>
  );
}
