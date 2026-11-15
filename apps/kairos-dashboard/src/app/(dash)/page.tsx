import Link from "next/link";
import { Empty, Json, PageHeader, Section, Stat } from "@/components/page";
import { Status } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { q, S } from "@/lib/db";
import { ago, num, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";

const statuses = ["running", "queued", "sleeping", "waiting", "completed", "failed", "cancelled"];

export default async function Overview() {
  const [byStatus, live, tenants, hourly, failures] = await Promise.all([
    q<{ status: string; d1: string; d7: string; live: string }>(
      `select status,
         count(*) filter (where created_at > now() - interval '24 hours') d1,
         count(*) filter (where created_at > now() - interval '7 days') d7,
         count(*) filter (where finished_at is null) live
       from ${S}.run group by status`,
    ),
    q<{ executing: string; ready: string; scheduled: string; open_ended: string; oldest_ready: Date | null }>(
      `select count(*) filter (where claimed_by is not null) executing,
         count(*) filter (where claimed_by is null and wake_at <= now()) ready,
         count(*) filter (where claimed_by is null and wake_at > now() and wake_at <> 'infinity') scheduled,
         count(*) filter (where wake_at = 'infinity') open_ended,
         min(wake_at) filter (where claimed_by is null and wake_at <= now()) oldest_ready
       from ${S}.wakeup`,
    ),
    q<{ tenant_id: string; ready: string; executing: string; oldest: Date | null }>(
      `select tenant_id,
         count(*) filter (where claimed_by is null and wake_at <= now()) ready,
         count(*) filter (where claimed_by is not null) executing,
         min(wake_at) filter (where claimed_by is null and wake_at <= now()) oldest
       from ${S}.wakeup group by tenant_id
       having count(*) filter (where claimed_by is not null or wake_at <= now()) > 0
       order by 2 desc, 3 desc limit 10`,
    ),
    q<{ h: Date; failed: string; completed: string }>(
      `select date_trunc('hour', finished_at) h,
         count(*) filter (where status = 'failed') failed,
         count(*) filter (where status = 'completed') completed
       from ${S}.run where finished_at > now() - interval '24 hours' group by 1 order by 1`,
    ),
    q<{
      id: string;
      workflow: string;
      version: number;
      tenant_id: string;
      error: { message?: string } | null;
      finished_at: Date;
    }>(
      `select id, workflow, version, tenant_id, error, finished_at from ${S}.run
       where status = 'failed' order by finished_at desc limit 8`,
    ),
  ]);
  const count = (s: string, k: "d1" | "d7" | "live") =>
    Number(byStatus.find((r) => r.status === s)?.[k] ?? 0);
  const l = live[0];
  // A fixed 24-slot axis, so a quiet day still reads as a day.
  const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const slots = Array.from({ length: 24 }, (_, i) => {
    const t = hourStart - (23 - i) * 3_600_000;
    const row = hourly.find((h) => new Date(h.h).getTime() === t);
    return { t, completed: Number(row?.completed ?? 0), failed: Number(row?.failed ?? 0) };
  });
  const max = Math.max(1, ...slots.map((h) => h.failed + h.completed));

  return (
    <>
      <PageHeader title="Overview" description="What's running, waiting and failing right now." />
      <div className="flex flex-col gap-5 p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Executing now" value={num(l?.executing)} hint={`${num(l?.ready)} ready to run`} />
          <Stat
            label="Oldest ready run"
            value={l?.oldest_ready ? ago(l.oldest_ready).replace(" ago", "") : "—"}
            hint="Waiting for a free worker"
          />
          <Stat
            label="Sleeping or waiting"
            value={num(Number(l?.scheduled ?? 0) + Number(l?.open_ended ?? 0))}
            hint={`${num(l?.open_ended)} with no deadline`}
          />
          <Stat
            label="Failed, last 24 h"
            value={num(count("failed", "d1"))}
            hint={`${num(count("completed", "d1"))} completed`}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <Section title="Finished runs per hour (24 h)">
            {hourly.length ? (
              <div className="px-4 pt-4 pb-3">
                <div
                  className="flex h-36 items-end gap-1"
                  role="img"
                  aria-label="Completed and failed runs per hour, last 24 hours"
                >
                  {slots.map((h) => (
                    <div
                      key={h.t}
                      className="flex h-full flex-1 flex-col justify-end"
                      title={`${new Date(h.t).getHours()}:00 · ${h.completed} completed, ${h.failed} failed`}
                    >
                      {h.failed ? (
                        <div
                          className="rounded-t-sm bg-destructive"
                          style={{ height: `${(h.failed / max) * 100}%` }}
                        />
                      ) : null}
                      <div
                        className={h.failed ? "bg-primary/70" : "rounded-t-sm bg-primary/70"}
                        style={{ height: `${(h.completed / max) * 100}%`, minHeight: h.completed ? 2 : 0 }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
                  <span>24 h ago</span>
                  <span>12 h ago</span>
                  <span>now</span>
                </div>
                <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-sm bg-primary/70" aria-hidden />
                    Completed
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-sm bg-destructive" aria-hidden />
                    Failed
                  </span>
                </div>
              </div>
            ) : (
              <Empty>Nothing finished in the last 24 hours.</Empty>
            )}
          </Section>
          <Section title="Runs by status">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">24 h</TableHead>
                  <TableHead className="text-right">7 d</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statuses.map((s) => (
                  <TableRow key={s}>
                    <TableCell>
                      <Link href={`/runs?status=${s}`}>
                        <Status value={s} />
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{num(count(s, "d1"))}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(count(s, "d7"))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="Busiest tenants">
            {tenants.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tenant</TableHead>
                    <TableHead className="text-right">Executing</TableHead>
                    <TableHead className="text-right">Ready</TableHead>
                    <TableHead className="text-right">Oldest ready</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenants.map((t) => (
                    <TableRow key={t.tenant_id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          className="hover:underline"
                          href={`/runs?tenant=${encodeURIComponent(t.tenant_id)}`}
                        >
                          {t.tenant_id}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(t.executing)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(t.ready)}</TableCell>
                      <TableCell className="text-right">{t.oldest ? ago(t.oldest) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>No tenant has runs executing or ready.</Empty>
            )}
          </Section>
          <Section
            title="Latest failures"
            right={
              <Link href="/runs?status=failed" className="text-xs text-primary hover:underline">
                All failed runs
              </Link>
            }
          >
            {failures.length ? (
              <ul className="divide-y">
                {failures.map((f) => (
                  <li key={f.id} className="px-4 py-2.5">
                    <Link
                      href={`/runs/${f.id}`}
                      className="flex items-baseline justify-between gap-3 hover:underline"
                    >
                      <span className="truncate text-sm font-medium">
                        {f.workflow}@{f.version}{" "}
                        <span className="font-mono text-xs text-muted-foreground">{shortId(f.id)}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{ago(f.finished_at)}</span>
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-destructive">{f.error?.message ?? "Failed"}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No failed runs. </Empty>
            )}
          </Section>
        </div>
        {byStatus.length === 0 ? <Json value="No runs yet: is Kairos migrated on this database?" /> : null}
      </div>
    </>
  );
}
