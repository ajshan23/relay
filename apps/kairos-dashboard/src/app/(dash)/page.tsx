import Link from "next/link";
import { Live } from "@/components/live";
import { Body, Empty, PageHeader, Section, Stat } from "@/components/page";
import { Status } from "@/components/status";
import { type RailData, TimeRail } from "@/components/time-rail";
import { q, S } from "@/lib/db";
import { ago, num, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";

const statuses = ["running", "queued", "sleeping", "waiting", "completed", "failed", "cancelled"];

export default async function Overview() {
  const [byStatus, live, tenants, past, future, failures] = await Promise.all([
    q<{ status: string; d1: string; d7: string }>(
      `select status,
         count(*) filter (where created_at > now() - interval '24 hours') d1,
         count(*) filter (where created_at > now() - interval '7 days') d7
       from ${S}.run group by status`,
    ),
    q<{ executing: string; ready: string; parked: string; open_ended: string; oldest_ready: Date | null }>(
      `select count(*) filter (where claimed_by is not null) executing,
         count(*) filter (where claimed_by is null and wake_at <= now()) ready,
         count(*) filter (where claimed_by is null and wake_at > now()) parked,
         count(*) filter (where wake_at = 'infinity') open_ended,
         min(wake_at) filter (where claimed_by is null and wake_at <= now()) oldest_ready
       from ${S}.wakeup`,
    ),
    q<{ tenant_id: string; ready: string; executing: string; parked: string }>(
      `select tenant_id,
         count(*) filter (where claimed_by is null and wake_at <= now()) ready,
         count(*) filter (where claimed_by is not null) executing,
         count(*) filter (where claimed_by is null and wake_at > now()) parked
       from ${S}.wakeup group by tenant_id order by 3 desc, 2 desc, 4 desc limit 8`,
    ),
    q<{ b: number; completed: string; failed: string }>(
      `select floor(extract(epoch from (now() - finished_at)) / 1800)::int b,
         count(*) filter (where status = 'completed') completed,
         count(*) filter (where status = 'failed') failed
       from ${S}.run where finished_at > now() - interval '12 hours' group by 1`,
    ),
    q<{ b: number; n: string }>(
      `select floor(extract(epoch from (wake_at - now())) / 1800)::int b, count(*) n
       from ${S}.wakeup where claimed_by is null and wake_at > now() and wake_at < now() + interval '12 hours'
       group by 1`,
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
       where status = 'failed' order by finished_at desc limit 6`,
    ),
  ]);
  const count = (s: string, k: "d1" | "d7") => Number(byStatus.find((r) => r.status === s)?.[k] ?? 0);
  const l = live[0];
  const rail: RailData = {
    past: Array.from({ length: 24 }, (_, i) => {
      const r = past.find((p) => Number(p.b) === i);
      return { completed: Number(r?.completed ?? 0), failed: Number(r?.failed ?? 0) };
    }),
    future: Array.from({ length: 24 }, (_, i) => Number(future.find((f) => Number(f.b) === i)?.n ?? 0)),
    readyNow: Number(l?.ready ?? 0),
  };
  const total7 = Math.max(1, ...statuses.map((s) => count(s, "d7")));
  const failed24 = count("failed", "d1");

  return (
    <>
      <PageHeader
        title="Overview"
        description="What ran, what's running, and what wakes up next."
        actions={<Live />}
      />
      <Body>
        <TimeRail data={rail} />

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label="Executing now"
            value={num(l?.executing)}
            tone="live"
            hint={`${num(l?.ready)} ready for a worker`}
          />
          <Stat
            label="Oldest ready run"
            value={l?.oldest_ready ? ago(l.oldest_ready).replace(" ago", "") : "None"}
            tone={l?.oldest_ready ? "warn" : undefined}
            hint={l?.oldest_ready ? "Waiting for a free worker" : "Nothing is queued up"}
          />
          <Stat
            label="Parked"
            value={num(l?.parked)}
            hint={`${num(l?.open_ended)} wait for an event with no deadline`}
          />
          <Stat
            label="Failed, last 24 hours"
            value={num(failed24)}
            tone={failed24 ? "bad" : "good"}
            hint={`${num(count("completed", "d1"))} completed`}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
          <Section title="Runs this week" description="Started in the last 7 days, by where they are now.">
            <ul className="flex flex-col gap-3 px-5 pb-5">
              {statuses.map((s) => {
                const n = count(s, "d7");
                return (
                  <li key={s}>
                    <Link
                      href={`/runs?status=${s}`}
                      className="group grid grid-cols-[96px_1fr_64px] items-center gap-3"
                    >
                      <Status value={s} className="justify-self-start" />
                      <span className="h-2 overflow-hidden rounded-full bg-muted">
                        <span
                          className={
                            s === "failed"
                              ? "block h-full rounded-full bg-destructive"
                              : s === "completed"
                                ? "block h-full rounded-full bg-rail-past"
                                : "block h-full rounded-full bg-primary/70"
                          }
                          style={{ width: `${(n / total7) * 100}%` }}
                        />
                      </span>
                      <span className="text-right text-sm tabular-nums group-hover:text-foreground">
                        {num(n)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section
            title="Latest failures"
            right={
              <Link href="/runs?status=failed" className="text-xs font-medium text-primary hover:underline">
                All failed runs
              </Link>
            }
          >
            {failures.length ? (
              <ul className="divide-y border-t">
                {failures.map((f) => (
                  <li key={f.id}>
                    <Link
                      href={`/runs/${f.id}`}
                      className="block px-5 py-3 transition-colors hover:bg-muted/50"
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-medium">
                          {f.workflow}
                          <span className="text-muted-foreground">@{f.version}</span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{ago(f.finished_at)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-destructive">
                        {f.error?.message ?? "Failed"}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                        {shortId(f.id)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No failed runs. Nothing to look into.</Empty>
            )}
          </Section>
        </div>

        <Section title="Tenants with live runs" description="Executing, ready, and parked until later.">
          {tenants.length ? (
            <div className="overflow-x-auto border-t">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">Tenant</th>
                    <th className="px-5 py-2.5 text-right font-medium">Executing</th>
                    <th className="px-5 py-2.5 text-right font-medium">Ready</th>
                    <th className="px-5 py-2.5 text-right font-medium">Parked</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tenants.map((t) => (
                    <tr key={t.tenant_id} className="transition-colors hover:bg-muted/40">
                      <td className="px-5 py-2.5 font-mono text-xs">
                        <Link
                          className="hover:text-primary"
                          href={`/runs?tenant=${encodeURIComponent(t.tenant_id)}`}
                        >
                          {t.tenant_id}
                        </Link>
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{num(t.executing)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{num(t.ready)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{num(t.parked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No tenant has a live run.</Empty>
          )}
        </Section>
      </Body>
    </>
  );
}
