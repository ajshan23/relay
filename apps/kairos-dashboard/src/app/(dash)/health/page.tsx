import { Empty, PageHeader, Section, Stat } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { q, S, schemaName } from "@/lib/db";
import { ago, num } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Is the engine itself healthy: table bloat, dead workers, wake-ups, and versions that can be removed. */
export default async function Health() {
  const [tables, stats, versions, stuck] = await Promise.all([
    q<{ relname: string; live: string; dead: string; last_autovacuum: Date | null }>(
      `select relname, n_live_tup live, n_dead_tup dead, greatest(last_autovacuum, last_vacuum) last_autovacuum
       from pg_stat_user_tables where schemaname = $1 and relname <> 'migration' order by relname`,
      [schemaName],
    ),
    q<{ notify: string; poll: string; reaped: string; infra: string; lost: string }>(
      `select coalesce(sum((stats->>'wakesByNotify')::int), 0) notify,
         coalesce(sum((stats->>'wakesByPoll')::int), 0) poll,
         coalesce(sum((stats->>'reclaimedByReaper')::int), 0) reaped,
         coalesce(sum((stats->>'infraRetries')::int), 0) infra,
         coalesce(sum((stats->>'lostClaims')::int), 0) lost
       from ${S}.worker where heartbeat_at > now() - interval '1 day'`,
    ),
    q<{ workflow: string; version: number; live: string; served: boolean; newest: number }>(
      `with live as (select workflow, version, count(*) live from ${S}.wakeup group by 1, 2),
       served as (
         select distinct unnest(workflows) k from ${S}.worker
         where stopped_at is null and heartbeat_at > now() - interval '45 seconds'
       ),
       known as (
         select split_part(k, '@', 1) workflow, split_part(k, '@', 2)::int version from served
         union select workflow, version from live
       )
       select k.workflow, k.version, coalesce(l.live, 0) live,
         exists (select 1 from served s where s.k = k.workflow || '@' || k.version) served,
         max(k.version) over (partition by k.workflow) newest
       from known k left join live l using (workflow, version)
       order by 1, 2 desc`,
    ),
    q<{ n: string; oldest: Date | null }>(
      `select count(*) n, min(wake_at) oldest from ${S}.wakeup
       where claimed_by is null and wake_at < now() - interval '5 minutes'`,
    ),
  ]);
  const s = stats[0];
  const st = stuck[0];

  return (
    <>
      <PageHeader title="Health" description="How the engine itself is doing." />
      <div className="flex flex-col gap-6 px-6 pb-12 lg:px-10">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat
            label="Ready for over 5 min"
            value={num(st?.n)}
            hint={Number(st?.n) ? `Oldest due ${ago(st?.oldest)}: workers busy or missing?` : "No backlog"}
          />
          <Stat label="Claims taken from dead workers (24 h)" value={num(s?.reaped)} />
          <Stat
            label="Engine write retries (24 h)"
            value={num(s?.infra)}
            hint="Deadlocks or lost connections, retried"
          />
          <Stat
            label="Instant wake-ups"
            value={Number(s?.notify) > 0 ? "On" : "Polling only"}
            hint={
              Number(s?.notify) > 0
                ? `${num(s?.notify)} wake-ups by notification (24 h)`
                : "Set KAIROS_LISTEN_URL to a direct database URL"
            }
          />
        </div>

        <Section title="Workflow versions">
          {versions.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Workflow</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Live runs</TableHead>
                  <TableHead className="pr-5">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((v) => {
                  const live = Number(v.live);
                  const state =
                    !v.served && live
                      ? { label: "No worker runs this version", tone: "bg-danger-soft text-destructive" }
                      : v.version < v.newest && live
                        ? { label: "Draining: keep it deployed", tone: "bg-warning-soft text-warning" }
                        : v.version < v.newest
                          ? { label: "Safe to remove", tone: "bg-good-soft text-good" }
                          : { label: "Current", tone: "bg-secondary text-foreground" };
                  return (
                    <TableRow key={`${v.workflow}@${v.version}`}>
                      <TableCell className="pl-5 font-mono text-xs">{v.workflow}</TableCell>
                      <TableCell>{v.version}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(live)}</TableCell>
                      <TableCell className="pr-5">
                        <Badge variant="outline" className={`border-transparent ${state.tone}`}>
                          {state.label}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>No workflows yet.</Empty>
          )}
        </Section>

        <Section title="Tables">
          {tables.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Table</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Dead rows</TableHead>
                  <TableHead className="text-right">Dead %</TableHead>
                  <TableHead className="pr-5">Last vacuum</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tables.map((t) => {
                  const live = Number(t.live);
                  const dead = Number(t.dead);
                  const pct = live + dead ? Math.round((dead / (live + dead)) * 100) : 0;
                  return (
                    <TableRow key={t.relname}>
                      <TableCell className="pl-5 font-mono text-xs">{t.relname}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(live)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(dead)}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${pct > 30 && dead > 10_000 ? "text-destructive" : ""}`}
                      >
                        {pct}%
                      </TableCell>
                      <TableCell className="pr-5 text-xs text-muted-foreground">
                        {ago(t.last_autovacuum)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>Kairos isn't migrated on this database yet.</Empty>
          )}
        </Section>
      </div>
    </>
  );
}
