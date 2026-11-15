import Link from "next/link";
import { cancelRuns, retryRuns } from "@/app/actions";
import { Filters, param } from "@/components/filters";
import { Body, Empty, PageHeader } from "@/components/page";
import { Status } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { q, S } from "@/lib/db";
import { ago, duration, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  tenant_id: string;
  workflow: string;
  version: number;
  serial_key: string | null;
  status: string;
  labels: Record<string, unknown>;
  created_at: Date;
  finished_at: Date | null;
};

const PAGE = 50;
const STATUSES = ["running", "queued", "sleeping", "waiting", "completed", "failed", "cancelled"];

export default async function Runs({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const f = {
    status: param(sp, "status"),
    workflow: param(sp, "workflow"),
    version: param(sp, "version"),
    tenant: param(sp, "tenant"),
    serial: param(sp, "serial"),
    idem: param(sp, "idem"),
    label: param(sp, "label"),
    before: param(sp, "before"),
  };
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, v: unknown) => {
    params.push(v);
    where.push(clause.replace("?", `$${params.length}`));
  };
  if (f.status) add("status = ?", f.status);
  if (f.workflow) add("workflow = ?", f.workflow);
  if (/^\d+$/.test(f.version)) add("version = ?::int", f.version);
  if (f.tenant) add("tenant_id = ?", f.tenant);
  if (f.serial) add("serial_key = ?", f.serial);
  if (f.idem) add("idempotency_key = ?", f.idem);
  if (f.label.includes("=")) {
    const [k = "", ...v] = f.label.split("=");
    add("labels @> ?::text::jsonb", JSON.stringify({ [k.trim()]: v.join("=").trim() }));
  }
  if (f.before) add("created_at < ?::timestamptz", f.before);
  params.push(PAGE + 1);
  const rows = await q<Row>(
    `select id, tenant_id, workflow, version, serial_key, status, labels, created_at, finished_at
     from ${S}.run ${where.length ? `where ${where.join(" and ")}` : ""}
     order by created_at desc limit $${params.length}`,
    params,
  );
  const page = rows.slice(0, PAGE);
  const next = new URLSearchParams(
    Object.entries(f).filter(([k, v]) => v && k !== "before") as [string, string][],
  );
  const last = page.at(-1);
  if (last) next.set("before", new Date(last.created_at).toISOString());

  return (
    <>
      <PageHeader title="Runs" description="Every run, newest first. Select runs to cancel or retry them." />
      <Body>
        <div className="overflow-hidden rounded-xl border bg-card shadow-elevated">
          <Filters
            action="/runs"
            values={f}
            fields={[
              { name: "status", label: "Status", options: STATUSES.map((s) => ({ value: s, label: s })) },
              { name: "workflow", label: "Workflow", placeholder: "relay.automation" },
              { name: "version", label: "Version", placeholder: "any" },
              { name: "tenant", label: "Tenant", placeholder: "org id" },
              { name: "serial", label: "Serial key", placeholder: "conversation id" },
              { name: "idem", label: "Idempotency key" },
              { name: "label", label: "Label", placeholder: "automationId=…" },
            ]}
          />
          <form>
            <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
              <Button type="submit" formAction={cancelRuns} size="sm" variant="outline">
                Cancel selected
              </Button>
              <Button type="submit" formAction={retryRuns} size="sm" variant="outline">
                Retry selected
              </Button>
              <span className="text-xs text-muted-foreground">
                Cancel stops unfinished runs. Retry re-runs failed or cancelled ones from the step that
                stopped.
              </span>
            </div>
            {page.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 pl-5">
                      <span className="sr-only">Select</span>
                    </TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tenant</TableHead>
                    <TableHead>Serial key</TableHead>
                    <TableHead>Labels</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="pr-5">Took</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="pl-5">
                        <Checkbox name="runId" value={r.id} aria-label={`Select run ${r.id}`} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <Link href={`/runs/${r.id}`} className="text-primary hover:underline">
                          {shortId(r.id)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm font-medium">
                        {r.workflow}
                        <span className="text-muted-foreground">@{r.version}</span>
                      </TableCell>
                      <TableCell>
                        <Status value={r.status} />
                      </TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-xs">{r.tenant_id}</TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-xs">
                        {r.serial_key ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground">
                        {Object.entries(r.labels ?? {})
                          .map(([k, v]) => `${k}=${String(v)}`)
                          .join(" ") || "—"}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        {ago(r.created_at)}
                      </TableCell>
                      <TableCell className="pr-5 text-xs whitespace-nowrap text-muted-foreground">
                        {r.finished_at ? duration(r.created_at, r.finished_at) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>No runs match these filters.</Empty>
            )}
          </form>
        </div>
        {rows.length > PAGE ? (
          <div className="flex justify-end">
            <Button asChild size="sm" variant="outline">
              <Link href={`/runs?${next.toString()}`}>Older runs</Link>
            </Button>
          </div>
        ) : null}
      </Body>
    </>
  );
}
