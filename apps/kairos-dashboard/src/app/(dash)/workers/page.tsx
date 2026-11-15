import { Empty, PageHeader, Section } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { q, S } from "@/lib/db";
import { ago, num } from "@/lib/format";

export const dynamic = "force-dynamic";

type Worker = {
  id: string;
  host: string;
  pid: number;
  workflows: string[];
  concurrency: number;
  started_at: Date;
  heartbeat_at: Date;
  stopped_at: Date | null;
  stats: Record<string, number>;
  alive: boolean;
  claimed: string;
};

export default async function Workers() {
  const [workers, tenants] = await Promise.all([
    q<Worker>(
      `select w.*, (w.stopped_at is null and w.heartbeat_at > now() - interval '45 seconds') alive,
         (select count(*) from ${S}.wakeup k where k.claimed_by = w.id) claimed
       from ${S}.worker w order by alive desc, heartbeat_at desc limit 100`,
    ),
    q<{ tenant_id: string; n: string }>(
      `select tenant_id, count(*) n from ${S}.wakeup where claimed_by is not null
       group by tenant_id order by 2 desc limit 20`,
    ),
  ]);
  return (
    <>
      <PageHeader title="Workers" description="Processes running workflows, with their last heartbeat." />
      <div className="flex flex-col gap-5 p-6">
        <Section title="Workers">
          {workers.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Worker</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Heartbeat</TableHead>
                  <TableHead className="text-right">Running now</TableHead>
                  <TableHead>Workflows</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="pr-4 text-right">Lost claims</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workers.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="pl-4">
                      <div className="font-mono text-xs">{w.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {w.host} · pid {w.pid} · up since {ago(w.started_at)}
                      </div>
                    </TableCell>
                    <TableCell>
                      {w.alive ? (
                        <Badge variant="outline" className="border-transparent bg-good-soft text-good">
                          Alive
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          {w.stopped_at ? "Stopped" : "Silent"}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{ago(w.heartbeat_at)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(w.claimed)} / {w.concurrency}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{w.workflows.join(", ")}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(w.stats?.completed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(w.stats?.failed)}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{num(w.stats?.lostClaims)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>No worker has started on this database yet.</Empty>
          )}
        </Section>
        <Section title="Runs executing per tenant">
          {tenants.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Tenant</TableHead>
                  <TableHead className="pr-4 text-right">Executing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((t) => (
                  <TableRow key={t.tenant_id}>
                    <TableCell className="pl-4 font-mono text-xs">{t.tenant_id}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{num(t.n)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>Nothing is executing right now.</Empty>
          )}
        </Section>
      </div>
    </>
  );
}
