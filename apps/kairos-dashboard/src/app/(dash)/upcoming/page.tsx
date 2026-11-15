import Link from "next/link";
import { Empty, PageHeader, Stat } from "@/components/page";
import { Status } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { q, S } from "@/lib/db";
import { ago, num, shortId, when } from "@/lib/format";

export const dynamic = "force-dynamic";

type Row = {
  run_id: string;
  tenant_id: string;
  workflow: string;
  version: number;
  status: string;
  wake_at: Date;
  event_key: string | null;
  scope: string | null;
};

/** Sleeping and waiting runs in the order they will wake. */
export default async function Upcoming() {
  const [rows, totals] = await Promise.all([
    q<Row>(
      `select w.run_id, w.tenant_id, w.workflow, w.version, r.status, w.wake_at, o.event_key, o.scope
       from ${S}.wakeup w join ${S}.run r on r.id = w.run_id
       left join ${S}.wait o on o.run_id = w.run_id and o.status = 'open'
       where w.claimed_by is null and w.wake_at > now()
       order by w.wake_at limit 200`,
    ),
    q<{ in_hour: string; in_day: string; later: string; never: string }>(
      `select count(*) filter (where wake_at <= now() + interval '1 hour') as in_hour,
         count(*) filter (where wake_at > now() + interval '1 hour' and wake_at <= now() + interval '1 day') as in_day,
         count(*) filter (where wake_at > now() + interval '1 day' and wake_at <> 'infinity') as later,
         count(*) filter (where wake_at = 'infinity') as never
       from ${S}.wakeup where claimed_by is null and wake_at > now()`,
    ),
  ]);
  const t = totals[0];
  return (
    <>
      <PageHeader title="Upcoming" description="Runs that are sleeping or waiting, in the order they wake." />
      <div className="grid grid-cols-2 gap-4 px-6 lg:px-10 md:grid-cols-4">
        <Stat label="Within an hour" value={num(t?.in_hour)} />
        <Stat label="Within a day" value={num(t?.in_day)} />
        <Stat label="Later" value={num(t?.later)} />
        <Stat
          label="Waiting, no deadline"
          value={num(t?.never)}
          hint="Wake only when their event arrives"
          tone="live"
        />
      </div>
      <div className="px-6 pt-6 pb-12 lg:px-10">
        <div className="overflow-hidden rounded-xl border bg-card shadow-elevated">
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Wakes</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Waiting for</TableHead>
                  <TableHead className="pr-4">Tenant</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.run_id}>
                    <TableCell className="pl-5 text-xs whitespace-nowrap">
                      {Number.isFinite(new Date(r.wake_at).getTime()) ? (
                        <>
                          {ago(r.wake_at)} <span className="text-muted-foreground">· {when(r.wake_at)}</span>
                        </>
                      ) : (
                        "When the event arrives"
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link href={`/runs/${r.run_id}`} className="text-primary hover:underline">
                        {shortId(r.run_id)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.workflow}
                      <span className="text-muted-foreground">@{r.version}</span>
                    </TableCell>
                    <TableCell>
                      <Status value={r.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.event_key ? `${r.event_key}${r.scope ? ` · ${r.scope}` : ""}` : "timer"}
                    </TableCell>
                    <TableCell className="max-w-40 truncate pr-4 font-mono text-xs">{r.tenant_id}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>Nothing is sleeping or waiting.</Empty>
          )}
        </div>
      </div>
    </>
  );
}
