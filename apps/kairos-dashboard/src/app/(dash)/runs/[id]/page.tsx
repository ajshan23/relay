import { AlarmClock, CircleDot, Hourglass, Radio } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelRuns, retryRuns } from "@/app/actions";
import { Json, PageHeader, Section } from "@/components/page";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { q, S } from "@/lib/db";
import { ago, duration, when } from "@/lib/format";

export const dynamic = "force-dynamic";

type Run = {
  id: string;
  tenant_id: string;
  workflow: string;
  version: number;
  serial_key: string | null;
  status: string;
  input: unknown;
  output: unknown;
  error: { name?: string; message?: string; stack?: string } | null;
  idempotency_key: string | null;
  labels: Record<string, unknown>;
  priority: number;
  claims: number;
  claim_losses: number;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};
type Step = {
  seq: number;
  kind: "step" | "sleep" | "wait";
  name: string;
  status: string;
  result: unknown;
  error: { message?: string } | null;
  attempt: number;
  wake_at: Date | null;
  started_at: Date;
  completed_at: Date | null;
};
type Wait = {
  seq: number;
  event_key: string;
  scope: string;
  filter: unknown;
  deadline: Date | null;
  status: string;
  event_id: string | null;
  payload: unknown;
  created_at: Date;
  resolved_at: Date | null;
};

const kindIcon = { step: CircleDot, sleep: AlarmClock, wait: Radio } as const;

export default async function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [run] = await q<Run>(`select * from ${S}.run where id = $1`, [id]);
  if (!run) notFound();
  const [steps, waits, wake] = await Promise.all([
    q<Step>(`select * from ${S}.step where run_id = $1 order by seq`, [id]),
    q<Wait>(
      `select w.*, e.payload from ${S}.wait w left join ${S}.event e on e.id = w.event_id
       where w.run_id = $1 order by w.seq`,
      [id],
    ),
    q<{ wake_at: Date; claimed_by: string | null; claimed_until: Date | null; attempt: number }>(
      `select wake_at, claimed_by, claimed_until, attempt from ${S}.wakeup where run_id = $1`,
      [id],
    ),
  ]);
  const w = wake[0];
  const live = !run.finished_at;
  const canRetry = run.status === "failed" || run.status === "cancelled";
  const waitBySeq = new Map(waits.map((x) => [x.seq, x]));

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {run.workflow}
            <span className="text-muted-foreground">@{run.version}</span>
            <Status value={run.status} />
          </span>
        }
        description={<span className="font-mono text-xs">{run.id}</span>}
        actions={
          <form className="flex gap-2">
            <input type="hidden" name="runId" value={run.id} />
            {live ? (
              <Button type="submit" formAction={cancelRuns} variant="outline" size="sm">
                Cancel run
              </Button>
            ) : null}
            {canRetry ? (
              <Button type="submit" formAction={retryRuns} size="sm">
                Retry from the failed step
              </Button>
            ) : null}
          </form>
        }
      />
      <div className="grid gap-6 px-6 pb-12 lg:px-10 xl:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Section
            title="Timeline"
            description="Every step it recorded, in order. A replay returns these results."
          >
            <ol className="relative px-5 pb-5">
              <span className="absolute top-3 bottom-8 left-[33px] w-px bg-border" aria-hidden />
              <TimelineItem
                icon={<Hourglass className="size-3.5" />}
                tone="muted"
                title="Started"
                meta={`${when(run.created_at)}, claimed ${run.claims} time${run.claims === 1 ? "" : "s"}${
                  run.claim_losses
                    ? `, lost its worker ${run.claim_losses} time${run.claim_losses === 1 ? "" : "s"}`
                    : ""
                }`}
              />
              {steps.map((s) => {
                const Icon = kindIcon[s.kind];
                const wt = waitBySeq.get(s.seq);
                return (
                  <TimelineItem
                    key={s.seq}
                    icon={<Icon className="size-3.5" />}
                    tone={
                      s.status === "failed"
                        ? "bad"
                        : s.status === "completed"
                          ? "good"
                          : s.status === "waiting"
                            ? "live"
                            : "warn"
                    }
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <span>{s.name}</span>
                        <Status value={s.status} />
                        {s.attempt > 1 ? (
                          <span className="text-xs font-normal text-muted-foreground">
                            attempt {s.attempt}
                          </span>
                        ) : null}
                      </span>
                    }
                    meta={[
                      `${s.kind === "step" ? "Step" : s.kind === "sleep" ? "Sleep" : "Wait"} ${s.seq}, ${when(s.started_at)}`,
                      s.completed_at ? `took ${duration(s.started_at, s.completed_at)}` : null,
                      s.kind === "sleep" && s.wake_at ? `wakes ${when(s.wake_at)}` : null,
                      wt
                        ? `waits for "${wt.event_key}"${wt.scope ? ` in ${wt.scope}` : ""}${wt.deadline ? ` until ${when(wt.deadline)}` : ", no deadline"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    action={
                      canRetry ? (
                        <form>
                          <input type="hidden" name="runId" value={run.id} />
                          <input type="hidden" name="fromSeq" value={s.seq} />
                          <Button type="submit" formAction={retryRuns} size="xs" variant="ghost">
                            Retry from here
                          </Button>
                        </form>
                      ) : null
                    }
                  >
                    {s.error ? (
                      <p className="mt-1.5 text-xs text-destructive">{s.error.message ?? "Failed"}</p>
                    ) : null}
                    {s.result !== null && s.result !== undefined ? (
                      <details className="group mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Result
                        </summary>
                        <Json value={s.result} className="mt-1.5" />
                      </details>
                    ) : null}
                  </TimelineItem>
                );
              })}
              {run.finished_at ? (
                <TimelineItem
                  icon={<Hourglass className="size-3.5" />}
                  tone={run.status === "failed" ? "bad" : run.status === "completed" ? "good" : "muted"}
                  title={<Status value={run.status} />}
                  meta={`${when(run.finished_at)}, ${duration(run.created_at, run.finished_at)} in all`}
                />
              ) : (
                <TimelineItem
                  icon={<Hourglass className="size-3.5" />}
                  tone="live"
                  title="Next"
                  meta={
                    w?.claimed_by
                      ? `Executing on ${w.claimed_by} (claim ${w.attempt}, lease until ${when(w.claimed_until)})`
                      : w
                        ? `Wakes ${when(w.wake_at)} (${ago(w.wake_at)})`
                        : "Not scheduled"
                  }
                />
              )}
            </ol>
          </Section>

          {run.error ? (
            <Section title="Error">
              <div className="flex flex-col gap-2 p-4">
                <p className="text-sm text-destructive">
                  {run.error.name}: {run.error.message}
                </p>
                {run.error.stack ? (
                  <pre className="max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                    {run.error.stack}
                  </pre>
                ) : null}
              </div>
            </Section>
          ) : null}

          {waits.length ? (
            <Section title="Waits">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Step</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead className="pr-4">Matched event</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {waits.map((x) => (
                    <TableRow key={x.seq}>
                      <TableCell className="pl-4">{x.seq}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {x.event_key}
                        {x.scope ? ` · ${x.scope}` : ""}
                      </TableCell>
                      <TableCell>
                        <Status value={x.status} />
                      </TableCell>
                      <TableCell className="text-xs">{x.deadline ? when(x.deadline) : "none"}</TableCell>
                      <TableCell className="pr-4">
                        {x.event_id ? (
                          <details>
                            <summary className="cursor-pointer font-mono text-xs text-primary">
                              {x.event_id}
                            </summary>
                            <Json value={x.payload} className="mt-1" />
                          </details>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <Section title="Details">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 p-4 text-sm">
              <dt className="text-muted-foreground">Tenant</dt>
              <dd className="truncate font-mono text-xs">
                <Link href={`/runs?tenant=${encodeURIComponent(run.tenant_id)}`} className="hover:underline">
                  {run.tenant_id}
                </Link>
              </dd>
              <dt className="text-muted-foreground">Serial key</dt>
              <dd className="truncate font-mono text-xs">
                {run.serial_key ? (
                  <Link
                    href={`/runs?serial=${encodeURIComponent(run.serial_key)}`}
                    className="hover:underline"
                  >
                    {run.serial_key}
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
              <dt className="text-muted-foreground">Idempotency</dt>
              <dd className="truncate font-mono text-xs">{run.idempotency_key ?? "—"}</dd>
              <dt className="text-muted-foreground">Priority</dt>
              <dd>{run.priority}</dd>
              {run.cancel_requested_at ? (
                <>
                  <dt className="text-muted-foreground">Cancel asked</dt>
                  <dd className="text-xs">{when(run.cancel_requested_at)}</dd>
                </>
              ) : null}
            </dl>
          </Section>
          <Section title="Labels">
            <div className="p-4">
              <Json value={run.labels} />
            </div>
          </Section>
          <Section title="Input">
            <div className="p-4">
              <Json value={run.input} />
            </div>
          </Section>
          {run.output !== null ? (
            <Section title="Output">
              <div className="p-4">
                <Json value={run.output} />
              </div>
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}

function TimelineItem({
  icon,
  tone,
  title,
  meta,
  action,
  children,
}: {
  icon: React.ReactNode;
  tone: "good" | "bad" | "warn" | "live" | "muted";
  title: React.ReactNode;
  meta?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const ring = {
    good: "border-good/40 bg-good-soft text-good",
    bad: "border-destructive/40 bg-danger-soft text-destructive",
    warn: "border-warning/40 bg-warning-soft text-warning",
    live: "border-primary/50 bg-accent text-accent-foreground",
    muted: "border-border bg-muted text-muted-foreground",
  }[tone];
  return (
    <li className="relative flex gap-4 py-3">
      <span
        className={`relative z-10 mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full border ${ring}`}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm font-medium">{title}</div>
          {action}
        </div>
        {meta ? <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div> : null}
        {children}
      </div>
    </li>
  );
}
