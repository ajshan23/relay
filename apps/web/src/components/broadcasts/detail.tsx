"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { Icon } from "@relay/ui/components/icon";
import { PageHeader } from "@relay/ui/components/page-header";
import { Panel, Section } from "@relay/ui/components/section";
import { Stat, StatGroup } from "@relay/ui/components/stat";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Progress } from "@relay/ui/ui/progress";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@relay/ui/ui/tabs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError } from "@/lib/api";
import { type Recipient, useBroadcast, useBroadcastActions, useRecipients } from "./queries";
import {
  channelNames,
  followUpWho,
  pauseText,
  skipText,
  statusLabel,
  statusTone,
  weekdays,
  when,
} from "./words";

const col = createDataTableColumns<Recipient>();
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

/** One broadcast: progress, why it's paused, pause / resume / stop, and who got what. */
export function BroadcastDetail({ id }: { id: string }) {
  const router = useRouter();
  const branch = useBranch().branch.id;
  const data = useBroadcast(id);
  const actions = useBroadcastActions();
  const [confirm, confirmElement] = useConfirm();
  const [status, setStatus] = useState("");
  const recipients = useRecipients(id, status);

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "Contact",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{row.original.name ?? "—"}</span>
            <span className="text-xs text-muted-foreground">
              {row.original.address.startsWith("none:") ? "No number" : `+${row.original.address}`}
            </span>
          </span>
        ),
      }),
      col.accessor("status", {
        header: "Status",
        cell: ({ row }) => (
          <Tag size="sm">{row.original.status === "held_back" ? "held back" : row.original.status}</Tag>
        ),
      }),
      col.display({
        id: "why",
        header: "Details",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.skipReason
              ? (skipText[row.original.skipReason] ?? row.original.skipReason)
              : (row.original.error ?? (row.original.repliedAt ? "Replied" : ""))}
          </span>
        ),
      }),
      col.accessor("sentAt", {
        header: "Sent",
        cell: ({ row }) => <span className="text-muted-foreground">{when(row.original.sentAt)}</span>,
      }),
    ],
    [],
  );

  if (!data.data)
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8 sm:px-8">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  const {
    broadcast: b,
    reasons,
    template,
    canManage,
    retrying,
    variants,
    followUps,
    parent,
    templateNames,
  } = data.data;
  const done = b.total - b.pending;
  const act = (action: "pause" | "resume" | "stop", ok: string) =>
    actions.act.mutate(
      { id: b.id, action },
      {
        onSuccess: () => notify.success(ok),
        onError: (err) =>
          notify.error("That didn't work", {
            description: err instanceof ApiError ? err.message : undefined,
          }),
      },
    );

  const buttons = canManage ? (
    <>
      {b.status === "draft" ? (
        <>
          <Button size="sm" asChild>
            <Link href={`/broadcasts/${b.id}/edit`}>
              <Icon name="edit" />
              Continue editing
            </Link>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (
                !(await confirm({
                  title: "Delete this draft?",
                  description: "It was never sent, so nobody is affected.",
                  confirmLabel: "Delete",
                  tone: "danger",
                }))
              )
                return;
              await actions.remove.mutateAsync(b.id);
              router.push("/broadcasts");
            }}
          >
            Delete
          </Button>
        </>
      ) : null}
      {b.status === "sending" || b.status === "scheduled" || b.status === "preparing" ? (
        <Button size="sm" variant="outline" onClick={() => act("pause", "Paused")}>
          <Icon name="pause" />
          Pause
        </Button>
      ) : null}
      {b.status === "paused" ? (
        <Button size="sm" onClick={() => act("resume", "Resumed")}>
          <Icon name="play" />
          Resume
        </Button>
      ) : null}
      {["scheduled", "preparing", "sending", "paused"].includes(b.status) ? (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const ok = await confirm({
              title: "Stop this broadcast?",
              description:
                "Nobody else will get it. People who already got it aren't affected. This can't be undone.",
              confirmLabel: "Stop broadcast",
              tone: "danger",
            });
            if (ok) act("stop", "Stopped");
          }}
        >
          Stop
        </Button>
      ) : null}
    </>
  ) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 pb-12">
      {confirmElement}
      <PageHeader
        title={b.name}
        breadcrumb={[{ label: "Broadcasts", href: "/broadcasts" }, { label: b.name }]}
        description={`${channelNames[b.channelType] ?? b.channelType}${template ? ` · ${template.name}` : ""}`}
        actions={buttons}
      />
      <div className="flex flex-col gap-6 px-5 sm:px-8">
        <Panel padding="lg" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Tag tone={statusTone[b.status]}>{statusLabel[b.status]}</Tag>
            <span className="text-sm text-muted-foreground">
              {b.status === "scheduled"
                ? `Starts ${b.schedule.startAt ? when(b.schedule.startAt) : "in a moment"}`
                : b.startedAt
                  ? `Started ${when(b.startedAt)}${b.completedAt ? ` · ended ${when(b.completedAt)}` : ""}`
                  : ""}
            </span>
          </div>
          {(b.status === "paused" || b.status === "stopped" || b.status === "failed") && b.pauseReason ? (
            <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-50">
              <Icon name="alert" size="sm" className="mt-0.5 shrink-0" />
              <span>
                {pauseText[b.pauseReason] ?? b.pauseDetail}
                {b.pauseDetail && pauseText[b.pauseReason] && b.pauseReason !== "manual" ? (
                  <span className="block text-xs opacity-70">{b.pauseDetail}</span>
                ) : null}
              </span>
            </div>
          ) : b.status === "sending" && b.pauseDetail ? (
            <p className="text-sm text-muted-foreground">
              {b.pauseDetail.replace(/\(opens (.+)\)/, (_m, iso: string) => `(opens ${when(iso)})`)}
            </p>
          ) : null}
          {b.total ? (
            <div className="flex flex-col gap-1.5">
              <Progress value={(done / b.total) * 100} />
              <span className="text-xs text-muted-foreground tabular-nums">
                {done.toLocaleString()} of {b.total.toLocaleString()} handled · {b.pending.toLocaleString()}{" "}
                waiting
              </span>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {b.schedule.window
              ? `Sends ${b.schedule.window.days.length === 7 ? "every day" : b.schedule.window.days.map((d) => weekdays[d - 1]).join(", ")}, ${b.schedule.window.from}–${b.schedule.window.to}`
              : "Sends at any time"}
            {b.schedule.timezone ? ` (${b.schedule.timezone})` : ""}
            {b.schedule.perDay
              ? ` · up to ${b.schedule.perDay.toLocaleString()} a day`
              : b.schedule.endBy
                ? ` · finishing by ${new Date(b.schedule.endBy).toLocaleDateString()}`
                : " · up to 75% of the daily limit"}
            {b.schedule.retry?.enabled === false
              ? " · people Meta holds back aren't retried"
              : ` · people Meta holds back are retried up to ${b.schedule.retry?.attempts ?? 1}×`}
          </p>
          {retrying.count ? (
            <p className="text-sm text-muted-foreground">
              {retrying.count.toLocaleString()} held back by Meta will be tried again
              {retrying.next ? ` (next: ${when(retrying.next)})` : ""}.
            </p>
          ) : null}
          {parent ? (
            <p className="text-sm text-muted-foreground">
              Follow-up of{" "}
              <Link className="underline underline-offset-2" href={`/broadcasts/${parent.id}`}>
                {parent.name}
              </Link>
            </p>
          ) : null}
        </Panel>

        {b.test ? (
          <Section title="A/B test">
            <Panel padding="lg" className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {(["A", "B"] as const).map((k) => {
                  const v = variants.find((x) => x.variant === k);
                  const good = b.test?.metric === "replied" ? (v?.replied ?? 0) : (v?.read ?? 0);
                  const name =
                    k === "A"
                      ? template?.name
                      : b.content.kind === "template" && b.content.variantB
                        ? templateNames[b.content.variantB.templateId]
                        : undefined;
                  return (
                    <div key={k} className="flex flex-col gap-1 rounded-lg border p-3">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {k}: {name ?? "—"}
                        </span>
                        {b.winner?.key === k ? <Tag tone="good">Winner</Tag> : null}
                      </span>
                      <span className="text-2xl font-semibold tabular-nums">{pct(good, v?.sent ?? 0)}</span>
                      <span className="text-xs text-muted-foreground">
                        {b.test?.metric === "replied" ? "replied" : "read"} · {good.toLocaleString()} of{" "}
                        {(v?.sent ?? 0).toLocaleString()} sent ({(v?.total ?? 0).toLocaleString()} in the
                        group)
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">
                {b.winner
                  ? `${b.winner.key} ${b.winner.by === "manual" ? "was picked by your team" : "won"} ${when(b.winner.decidedAt)}; the other ${(variants.find((x) => x.variant === "rest")?.total ?? 0).toLocaleString()} get ${b.winner.key}.`
                  : `The winner is picked ${b.test.decideAfterHours} h after both test groups are sent; then everyone else (${(variants.find((x) => x.variant === "rest")?.total ?? 0).toLocaleString()}) gets it.`}
              </p>
              {canManage && !b.winner && ["sending", "paused"].includes(b.status) ? (
                <div className="flex gap-2">
                  {(["A", "B"] as const).map((k) => (
                    <Button
                      key={k}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        actions.winner.mutate(
                          { id: b.id, key: k },
                          {
                            onSuccess: () => notify.success(`${k} goes to everyone else`),
                            onError: (err) =>
                              notify.error("That didn't work", {
                                description: err instanceof ApiError ? err.message : undefined,
                              }),
                          },
                        )
                      }
                    >
                      Pick {k} now
                    </Button>
                  ))}
                </div>
              ) : null}
            </Panel>
          </Section>
        ) : null}

        {b.followUp ? (
          <Section title="Follow-up">
            <Panel padding="lg" className="flex flex-col gap-3">
              <p className="text-sm">
                {templateNames[b.followUp.templateId] ?? "A template"}, {b.followUp.hours} h after the
                broadcast is done, to people who {followUpWho[b.followUp.who]}.
              </p>
              {followUps.length ? (
                followUps.map((f) => (
                  <Link
                    key={f.id}
                    href={`/broadcasts/${f.id}`}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
                  >
                    <span className="font-medium">{f.name}</span>
                    <span className="flex items-center gap-3 text-muted-foreground tabular-nums">
                      {f.sent.toLocaleString()} sent · {f.read.toLocaleString()} read
                      <Tag size="sm" tone={statusTone[f.status]}>
                        {statusLabel[f.status]}
                      </Tag>
                    </span>
                  </Link>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">
                  {b.status === "completed"
                    ? "Starts once the wait is over."
                    : b.status === "stopped" || b.status === "failed"
                      ? "Not sent: the broadcast didn't finish."
                      : "Starts after the broadcast is done."}
                </p>
              )}
            </Panel>
          </Section>
        ) : null}

        <StatGroup>
          <Stat label="Sent" value={b.sent.toLocaleString()} note={pct(b.sent, b.total - b.skipped)} />
          <Stat label="Delivered" value={b.delivered.toLocaleString()} note={pct(b.delivered, b.sent)} />
          <Stat label="Read" value={b.read.toLocaleString()} note={pct(b.read, b.delivered)} />
          <Stat label="Replied" value={b.replied.toLocaleString()} note={pct(b.replied, b.delivered)} />
          <Stat label="Held back" value={b.heldBack.toLocaleString()} note="by Meta, not retried" />
          <Stat label="Failed" value={b.failed.toLocaleString()} />
          <Stat label="Skipped" value={b.skipped.toLocaleString()} />
        </StatGroup>

        {reasons.length ? (
          <Section title="Not reached, and why">
            <Panel padding="none">
              <ul className="divide-y">
                {reasons.map((x) => (
                  <li
                    key={`${x.status}${x.reason}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                  >
                    <span>{skipText[x.reason] ?? x.reason}</span>
                    <span className="tabular-nums text-muted-foreground">{x.n.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </Section>
        ) : null}

        {b.total ? (
          <Section
            title="Recipients"
            actions={
              <Button size="sm" variant="outline" asChild>
                <a href={`/api${inBranch(`/broadcasts/${b.id}/export`, branch)}`}>
                  <Icon name="download" />
                  Export
                </a>
              </Button>
            }
          >
            <Tabs value={status} onValueChange={setStatus}>
              <TabsList>
                {[
                  ["", "All"],
                  ["pending", "Waiting"],
                  ["delivered", "Delivered"],
                  ["read", "Read"],
                  ["held_back", "Held back"],
                  ["failed", "Failed"],
                  ["skipped", "Skipped"],
                ].map(([v, l]) => (
                  <TabsTrigger key={v} value={v ?? ""}>
                    {l}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <DataTable
              aria-label="Recipients"
              columns={columns}
              data={recipients.data?.recipients ?? []}
              loading={recipients.isPending}
              getRowId={(x) => x.id}
            />
            {recipients.data?.next ? (
              <p className="text-xs text-muted-foreground">Showing the first 100. Export for everyone.</p>
            ) : null}
          </Section>
        ) : null}
      </div>
    </div>
  );
}
