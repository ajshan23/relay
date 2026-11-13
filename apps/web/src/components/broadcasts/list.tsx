"use client";

import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { PageHeader } from "@relay/ui/components/page-header";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { Button } from "@relay/ui/ui/button";
import { Progress } from "@relay/ui/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@relay/ui/ui/tabs";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { type Broadcast, useBroadcasts } from "./queries";
import { channelNames, statusLabel, statusTone, views, when } from "./words";

const col = createDataTableColumns<Broadcast>();

/**
 * /broadcasts: every broadcast of the branch, by channel and status. Shaped like the template samples
 * page: a channel filter (WhatsApp now; SMS and email later), tabs for the status, then the list.
 */
export function BroadcastsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = views[params.get("view") ?? "all"] ? (params.get("view") ?? "all") : "all";
  const [channel, setChannel] = useState("all");
  const list = useBroadcasts(channel);
  const statuses = views[view]?.statuses;
  const rows = (list.data ?? []).filter((x) => !statuses || statuses.includes(x.status));

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "Broadcast",
        cell: ({ row }) => (
          <Link href={`/broadcasts/${row.original.id}`} className="flex min-w-0 flex-col hover:underline">
            <span className="truncate font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">
              {channelNames[row.original.channelType] ?? row.original.channelType}
            </span>
          </Link>
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
      col.display({
        id: "progress",
        header: "Progress",
        cell: ({ row }) => {
          const x = row.original;
          if (!x.total) return <span className="text-xs text-muted-foreground">—</span>;
          const done = x.total - x.pending;
          return (
            <span className="flex w-40 flex-col gap-1">
              <Progress value={(done / x.total) * 100} className="h-1.5" />
              <span className="text-xs text-muted-foreground tabular-nums">
                {done.toLocaleString()} of {x.total.toLocaleString()}
              </span>
            </span>
          );
        },
      }),
      col.accessor("delivered", {
        header: "Delivered",
        cell: ({ row }) => <span className="tabular-nums">{row.original.delivered.toLocaleString()}</span>,
      }),
      col.accessor("read", {
        header: "Read",
        cell: ({ row }) => <span className="tabular-nums">{row.original.read.toLocaleString()}</span>,
      }),
      col.accessor("replied", {
        header: "Replied",
        cell: ({ row }) => <span className="tabular-nums">{row.original.replied.toLocaleString()}</span>,
      }),
      col.accessor("createdAt", {
        header: "When",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {when(row.original.startedAt ?? row.original.schedule.startAt ?? row.original.createdAt)}
          </span>
        ),
      }),
    ],
    [],
  );

  const newButton = (
    <Button size="sm" asChild>
      <Link href="/broadcasts/new">
        <Icon name="add" />
        New broadcast
      </Link>
    </Button>
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-12">
      <PageHeader
        title="Broadcasts"
        description="Messages you send to many contacts at once."
        actions={newButton}
      />
      <div className="flex flex-col gap-4 px-5 sm:px-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="w-full sm:w-48">
            <SelectField
              aria-label="Channel"
              value={channel}
              onValueChange={setChannel}
              options={[
                { value: "all", label: "All channels" },
                { value: "whatsapp", label: channelNames.whatsapp ?? "WhatsApp" },
                { value: "sms", label: `${channelNames.sms} (soon)`, disabled: true },
                { value: "email", label: `${channelNames.email} (soon)`, disabled: true },
              ]}
            />
          </div>
          <Tabs
            value={view}
            onValueChange={(v) => router.replace(`${pathname}${v === "all" ? "" : `?view=${v}`}`)}
            className="sm:ml-auto"
          >
            <TabsList>
              {Object.entries(views).map(([key, v]) => (
                <TabsTrigger key={key} value={key}>
                  {v.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <DataTable
          aria-label="Broadcasts"
          columns={columns}
          data={rows}
          loading={list.isPending}
          getRowId={(x) => x.id}
          empty={
            <EmptyState
              icon={<Icon name="campaigns" />}
              title={
                view === "all" ? "No broadcasts yet" : `No ${views[view]?.label.toLowerCase()} broadcasts`
              }
              description="Send an approved template to a list of contacts, spread over the hours and days you choose."
              action={newButton}
            />
          }
        />
      </div>
    </div>
  );
}
