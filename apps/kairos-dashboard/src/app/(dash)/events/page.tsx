import Link from "next/link";
import { Filters, param } from "@/components/filters";
import { Body, Empty, Json, PageHeader } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { q, S } from "@/lib/db";
import { ago, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  tenant_id: string;
  key: string;
  scope: string;
  payload: unknown;
  dedupe_key: string | null;
  matched_runs: string[];
  created_at: Date;
};

export default async function Events({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const f = { key: param(sp, "key"), scope: param(sp, "scope"), tenant: param(sp, "tenant") };
  const where: string[] = [];
  const params: unknown[] = [];
  for (const [col, v] of [
    ["key", f.key],
    ["scope", f.scope],
    ["tenant_id", f.tenant],
  ] as const) {
    if (!v) continue;
    params.push(v);
    where.push(`${col} = $${params.length}`);
  }
  const rows = await q<Row>(
    `select * from ${S}.event ${where.length ? `where ${where.join(" and ")}` : ""}
     order by created_at desc limit 100`,
    params,
  );
  return (
    <>
      <PageHeader title="Events" description="Published events and the runs each one woke." />
      <Body>
        <div className="overflow-hidden rounded-xl border bg-card shadow-elevated">
          <Filters
            action="/events"
            values={f}
            fields={[
              { name: "key", label: "Key", placeholder: "message.received" },
              { name: "scope", label: "Scope", placeholder: "conversation id" },
              { name: "tenant", label: "Tenant", placeholder: "org id" },
            ]}
          />
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">When</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Payload</TableHead>
                  <TableHead className="pr-5">Woke</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id} className="align-top">
                    <TableCell className="pl-5 text-xs whitespace-nowrap text-muted-foreground">
                      {ago(e.created_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.key}</TableCell>
                    <TableCell className="max-w-40 truncate font-mono text-xs">{e.scope || "—"}</TableCell>
                    <TableCell className="max-w-40 truncate font-mono text-xs">{e.tenant_id}</TableCell>
                    <TableCell className="max-w-md">
                      <details>
                        <summary className="cursor-pointer truncate font-mono text-xs text-muted-foreground">
                          {JSON.stringify(e.payload)?.slice(0, 80) ?? "null"}
                        </summary>
                        <Json value={e.payload} className="mt-1" />
                      </details>
                    </TableCell>
                    <TableCell className="pr-5 font-mono text-xs">
                      {e.matched_runs.length
                        ? e.matched_runs.map((r) => (
                            <Link key={r} href={`/runs/${r}`} className="block text-primary hover:underline">
                              {shortId(r)}
                            </Link>
                          ))
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>No events match.</Empty>
          )}
        </div>
      </Body>
    </>
  );
}
