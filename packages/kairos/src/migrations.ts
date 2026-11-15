import type { Sql } from "postgres";
import { lockKey, quoteSchema } from "./sql";

/*
 * Kairos owns one Postgres schema (default "kairos") and migrates it itself, so it works the same in
 * any app. Migrations are append-only: never edit one that has shipped, add the next number.
 *
 * Tables, in one line each:
 *   run     — one row per run, kept after it finishes (until retention removes it)
 *   wakeup  — narrow and hot: exactly one row per live run; claiming, sleeping and waking happen here
 *   step    — the run's step log, replayed to resume it
 *   wait    — a run waiting for an event (open → matched | timed_out | cancelled)
 *   event   — published events, for late waits (lookback) and the dashboard
 *   worker  — processes running workflows, with heartbeats and counters
 */

const S = "__S__";

const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
create table ${S}.run (
  id text primary key,
  tenant_id text not null,
  workflow text not null,
  version int not null,
  serial_key text,
  status text not null check (status in ('queued','running','sleeping','waiting','completed','failed','cancelled')),
  input jsonb,
  output jsonb,
  error jsonb,
  idempotency_key text,
  labels jsonb not null default '{}'::jsonb,
  priority smallint not null default 0,
  claims int not null default 0,
  claim_losses int not null default 0,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index run_idempotency_uq on ${S}.run (tenant_id, workflow, idempotency_key) where idempotency_key is not null;
create index run_status_idx on ${S}.run (status, created_at desc);
create index run_tenant_idx on ${S}.run (tenant_id, created_at desc);
create index run_workflow_idx on ${S}.run (workflow, created_at desc);
create index run_serial_idx on ${S}.run (serial_key, created_at desc) where serial_key is not null;
create index run_finished_idx on ${S}.run (finished_at) where finished_at is not null;
create index run_labels_idx on ${S}.run using gin (labels jsonb_path_ops);

create table ${S}.wakeup (
  run_id text primary key references ${S}.run(id) on delete cascade,
  tenant_id text not null,
  workflow text not null,
  version int not null,
  serial_key text,
  priority smallint not null default 0,
  wake_at timestamptz not null,
  claimed_by text,
  claimed_until timestamptz,
  attempt int not null default 0
) with (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.1, autovacuum_analyze_scale_factor = 0.05,
        autovacuum_vacuum_threshold = 25, autovacuum_vacuum_cost_delay = 10, autovacuum_vacuum_cost_limit = 1000);
create index wakeup_ready_idx on ${S}.wakeup (wake_at, priority desc) where claimed_by is null;
create index wakeup_claimed_idx on ${S}.wakeup (claimed_until) where claimed_by is not null;
create index wakeup_tenant_claimed_idx on ${S}.wakeup (tenant_id) where claimed_by is not null;
-- At most one run per serial key executes at a time, even if two workers race for it.
create unique index wakeup_serial_uq on ${S}.wakeup (tenant_id, serial_key) where claimed_by is not null and serial_key is not null;

create table ${S}.step (
  run_id text not null references ${S}.run(id) on delete cascade,
  seq int not null,
  kind text not null check (kind in ('step','sleep','wait')),
  name text not null,
  idem_hash text not null,
  status text not null check (status in ('completed','failed','retrying','waiting')),
  result jsonb,
  error jsonb,
  attempt int not null default 1,
  wake_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (run_id, seq)
) with (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.1, autovacuum_analyze_scale_factor = 0.05);

create table ${S}.wait (
  id text primary key,
  run_id text not null references ${S}.run(id) on delete cascade,
  seq int not null,
  tenant_id text not null,
  event_key text not null,
  scope text not null default '',
  filter jsonb,
  deadline timestamptz,
  status text not null check (status in ('open','matched','timed_out','cancelled')),
  event_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (run_id, seq)
) with (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.1, autovacuum_analyze_scale_factor = 0.05);
create index wait_open_idx on ${S}.wait (tenant_id, event_key, scope) where status = 'open';
create index wait_event_idx on ${S}.wait (event_id) where event_id is not null;

create table ${S}.event (
  id text primary key,
  tenant_id text not null,
  key text not null,
  scope text not null default '',
  payload jsonb,
  dedupe_key text,
  matched_runs text[] not null default '{}',
  created_at timestamptz not null default now()
);
create unique index event_dedupe_uq on ${S}.event (tenant_id, dedupe_key) where dedupe_key is not null;
create index event_lookup_idx on ${S}.event (tenant_id, key, scope, created_at);
create index event_created_idx on ${S}.event (created_at);

create table ${S}.worker (
  id text primary key,
  host text not null,
  pid int not null,
  workflows text[] not null,
  concurrency int not null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  stopped_at timestamptz,
  stats jsonb not null default '{}'::jsonb
);
`,
  },
];

export const latestMigration = migrations.at(-1)?.version ?? 0;

/** Brings the schema up to date. Safe to call from every process on start: one runs it, the rest wait. */
export async function migrate(sql: Sql, schema: string): Promise<{ applied: number[] }> {
  const s = quoteSchema(schema);
  const applied: number[] = [];
  await sql.begin(async (tx) => {
    await tx.unsafe("select pg_advisory_xact_lock($1::bigint)", [lockKey(`kairos:migrate:${schema}`)]);
    await tx.unsafe(`create schema if not exists ${s}`);
    await tx.unsafe(
      `create table if not exists ${s}.migration (version int primary key, applied_at timestamptz not null default now())`,
    );
    const rows = await tx.unsafe<{ v: number | null }[]>(`select max(version) as v from ${s}.migration`);
    const current = rows[0]?.v ?? 0;
    for (const m of migrations) {
      if (m.version <= current) continue;
      await tx.unsafe(m.sql.replaceAll(S, s));
      await tx.unsafe(`insert into ${s}.migration (version) values ($1)`, [m.version]);
      applied.push(m.version);
    }
  });
  return { applied };
}
