import postgres, { type Sql } from "postgres";
import { migrate } from "./migrations";
import { type Executor, finalizeCancelled, fromPostgres, json, lockKey, newId, quoteSchema } from "./sql";
import type {
  Logger,
  PublishInput,
  PublishResult,
  RunRow,
  RunStatus,
  StartOptions,
  StartResult,
  StepRow,
  Workflow,
  WorkflowHandler,
  WorkflowOptions,
} from "./types";
import { Worker, type WorkerOptions } from "./worker";

export type KairosOptions = {
  /** Postgres URL. A pooled URL (PgBouncer, Neon "-pooler") works. Or pass `sql`. */
  databaseUrl?: string;
  /** Use an existing postgres.js client instead of opening one. */
  sql?: Sql;
  /** A direct (non-pooled) URL for LISTEN, so workers wake within milliseconds. Without it they poll. */
  listenUrl?: string;
  /** Postgres schema Kairos owns. Default "kairos". */
  schema?: string;
  /** Pool size when Kairos opens its own client. Default 10. */
  maxConnections?: number;
  log?: Logger;
};

const defaultLog: Logger = (level, message, data) => {
  if (level === "debug" || level === "info") return;
  const line = `[kairos] ${message}`;
  if (level === "error") console.error(line, data ?? "");
  else console.warn(line, data ?? "");
};

export type Kairos = ReturnType<typeof createKairos>;

export function createKairos(options: KairosOptions) {
  const schemaName = options.schema ?? "kairos";
  const S = quoteSchema(schemaName);
  const ownsSql = !options.sql;
  const sql =
    options.sql ??
    postgres(options.databaseUrl ?? "", {
      max: options.maxConnections ?? 10,
      onnotice: () => {},
      connection: { application_name: "kairos" },
    });
  if (!options.sql && !options.databaseUrl) throw new Error("Kairos needs databaseUrl or sql");
  const pool = fromPostgres(sql);
  const log = options.log ?? defaultLog;
  /** NOTIFY channel workers listen on; the payload is the tenant id. */
  const channel = `kairos_wake_${schemaName}`;
  const workers = new Set<Worker>();

  function workflow<I = unknown, O = unknown>(
    opts: WorkflowOptions,
    handler: WorkflowHandler<I, O>,
  ): Workflow<I, O> {
    if (!/^[\w.:-]{1,120}$/.test(opts.name)) throw new Error(`Bad workflow name "${opts.name}"`);
    if (!Number.isInteger(opts.version) || opts.version < 1) throw new Error("Workflow version must be ≥ 1");
    return {
      name: opts.name,
      version: opts.version,
      retries: opts.retries ?? 3,
      stepTimeoutMs: opts.stepTimeoutMs ?? 60_000,
      backoff: {
        baseMs: opts.backoff?.baseMs ?? 1_000,
        factor: opts.backoff?.factor ?? 2,
        maxMs: opts.backoff?.maxMs ?? 300_000,
      },
      key: `${opts.name}@${opts.version}`,
      handler,
    };
  }

  /** Runs `fn` in the caller's transaction if they gave one, else in a new one of ours. */
  async function inTx<T>(executor: Executor | undefined, fn: (ex: Executor) => Promise<T>): Promise<T> {
    if (executor) return fn(executor);
    return (await sql.begin((tx) => fn(fromPostgres(tx)))) as T;
  }

  async function start<I>(wf: Workflow<I, unknown>, input: I, opts: StartOptions): Promise<StartResult> {
    if (!opts.tenantId) throw new Error("start needs a tenantId");
    const id = newId("run");
    return inTx(opts.executor, async (ex) => {
      const rows = await ex.query<{ id: string }>(
        `with ins as (
           insert into ${S}.run (id, tenant_id, workflow, version, serial_key, status, input, idempotency_key, labels, priority)
           values ($1, $2, $3, $4, $5, 'queued', $6::text::jsonb, $7, coalesce($8::text::jsonb, '{}'::jsonb), $9)
           on conflict (tenant_id, workflow, idempotency_key) where idempotency_key is not null do nothing
           returning id
         ), wk as (
           insert into ${S}.wakeup (run_id, tenant_id, workflow, version, serial_key, priority, wake_at)
           select id, $2, $3, $4, $5, $9, now() + ($10::double precision * interval '1 millisecond') from ins
         )
         select id from ins`,
        [
          id,
          opts.tenantId,
          wf.name,
          wf.version,
          opts.serialKey ?? null,
          json(input),
          opts.idempotencyKey ?? null,
          json(opts.labels),
          opts.priority ?? 0,
          Math.max(0, opts.delayMs ?? 0),
        ],
      );
      if (rows[0]) {
        if (!opts.delayMs) await ex.query("select pg_notify($1, $2)", [channel, opts.tenantId]);
        return { runId: rows[0].id, created: true };
      }
      const [existing] = await ex.query<{ id: string }>(
        `select id from ${S}.run where tenant_id = $1 and workflow = $2 and idempotency_key = $3`,
        [opts.tenantId, wf.name, opts.idempotencyKey ?? null],
      );
      if (!existing) throw new Error("Kairos start: idempotency conflict but no existing run");
      return { runId: existing.id, created: false };
    });
  }

  /**
   * Records an event and wakes every run waiting for it. Takes the same lock as a run starting to wait
   * on that key and scope, so an event is never lost between "no open wait yet" and "wait registered".
   */
  async function publish(event: PublishInput, opts: { executor?: Executor } = {}): Promise<PublishResult> {
    const scope = event.scope ?? "";
    return inTx(opts.executor, async (ex) => {
      await ex.query("select pg_advisory_xact_lock($1::bigint)", [
        lockKey(`${schemaName}:${event.tenantId}:${event.key}:${scope}`),
      ]);
      const id = newId("evt");
      const ins = await ex.query<{ id: string }>(
        `insert into ${S}.event (id, tenant_id, key, scope, payload, dedupe_key)
         values ($1, $2, $3, $4, $5::text::jsonb, $6)
         on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing
         returning id`,
        [id, event.tenantId, event.key, scope, json(event.payload), event.dedupeKey ?? null],
      );
      if (!ins[0]) return { eventId: null, duplicate: true, matchedRuns: [] };
      const matched = await ex.query<{ run_id: string }>(
        `with m as (
           update ${S}.wait set status = 'matched', event_id = $1, resolved_at = now()
           where tenant_id = $2 and event_key = $3 and scope = $4 and status = 'open'
             and (filter is null or coalesce($5::text::jsonb, 'null'::jsonb) @> filter)
           returning run_id
         ), w as (
           update ${S}.wakeup set wake_at = now() where run_id in (select run_id from m)
         ), e as (
           update ${S}.event set matched_runs = coalesce((select array_agg(run_id) from m), '{}') where id = $1
         )
         select run_id from m`,
        [id, event.tenantId, event.key, scope, json(event.payload)],
      );
      if (matched.length) await ex.query("select pg_notify($1, $2)", [channel, event.tenantId]);
      return { eventId: id, duplicate: false, matchedRuns: matched.map((m) => m.run_id) };
    });
  }

  /**
   * Cancels a run. A sleeping, waiting or queued run stops at once; a run executing right now stops at
   * its next step. Finished runs are left alone. Returns whether the run is (or will be) cancelled.
   */
  async function cancel(runId: string, opts: { executor?: Executor } = {}): Promise<boolean> {
    return inTx(opts.executor, async (ex) => {
      // Lock order everywhere: wakeup row, then run row.
      await ex.query(`select run_id from ${S}.wakeup where run_id = $1 for update`, [runId]);
      const req = await ex.query<{ id: string }>(
        `update ${S}.run set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
         where id = $1 and status not in ('completed','failed','cancelled') returning id`,
        [runId],
      );
      if (!req[0]) return false;
      const freed = await ex.query(
        `delete from ${S}.wakeup where run_id = $1 and claimed_by is null returning run_id`,
        [runId],
      );
      if (freed[0]) await finalizeCancelled(ex, S, runId);
      return true;
    });
  }

  /**
   * Runs a failed or cancelled run again. By default it resumes at the step that failed (earlier steps
   * keep their results); `fromSeq` replays from an earlier step instead.
   */
  async function retry(runId: string, opts: { fromSeq?: number } = {}): Promise<void> {
    await sql.begin(async (tx) => {
      const ex = fromPostgres(tx);
      const [run] = await ex.query<RunRow>(`select * from ${S}.run where id = $1 for update`, [runId]);
      if (!run) throw new Error("Run not found");
      if (run.status !== "failed" && run.status !== "cancelled")
        throw new Error(`Only failed or cancelled runs can be retried (this one is ${run.status})`);
      const [first] = await ex.query<{ seq: number | null }>(
        `select min(seq) as seq from ${S}.step where run_id = $1 and status <> 'completed'`,
        [runId],
      );
      const from = opts.fromSeq ?? first?.seq ?? null;
      if (from !== null) {
        await ex.query(`delete from ${S}.step where run_id = $1 and seq >= $2`, [runId, from]);
        await ex.query(`delete from ${S}.wait where run_id = $1 and seq >= $2`, [runId, from]);
      }
      await ex.query(
        `update ${S}.run set status = 'queued', error = null, output = null, finished_at = null,
           cancel_requested_at = null, claim_losses = 0, updated_at = now() where id = $1`,
        [runId],
      );
      await ex.query(
        `insert into ${S}.wakeup (run_id, tenant_id, workflow, version, serial_key, priority, wake_at)
         values ($1, $2, $3, $4, $5, $6, now()) on conflict (run_id) do nothing`,
        [run.id, run.tenant_id, run.workflow, run.version, run.serial_key, run.priority],
      );
      await ex.query("select pg_notify($1, $2)", [channel, run.tenant_id]);
    });
  }

  async function getRun(runId: string) {
    const [run] = await pool.query<RunRow>(`select * from ${S}.run where id = $1`, [runId]);
    if (!run) return null;
    const steps = await pool.query<StepRow>(`select * from ${S}.step where run_id = $1 order by seq`, [
      runId,
    ]);
    const waits = await pool.query(`select * from ${S}.wait where run_id = $1 order by seq`, [runId]);
    const [wake] = await pool.query<{ wake_at: Date; claimed_by: string | null }>(
      `select wake_at, claimed_by from ${S}.wakeup where run_id = $1`,
      [runId],
    );
    return { run, steps, waits, wakeup: wake ?? null };
  }

  async function listRuns(
    filter: {
      tenantId?: string;
      workflow?: string;
      status?: RunStatus[];
      serialKey?: string;
      labels?: Record<string, unknown>;
      before?: Date;
      limit?: number;
    } = {},
  ): Promise<RunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (filter.tenantId) add("tenant_id = ?", filter.tenantId);
    if (filter.workflow) add("workflow = ?", filter.workflow);
    if (filter.status?.length) add("status = any(?::text[])", filter.status);
    if (filter.serialKey) add("serial_key = ?", filter.serialKey);
    if (filter.labels) add("labels @> ?::text::jsonb", JSON.stringify(filter.labels));
    if (filter.before) add("created_at < ?", filter.before.toISOString());
    params.push(Math.min(Math.max(filter.limit ?? 50, 1), 500));
    return pool.query<RunRow>(
      `select * from ${S}.run ${where.length ? `where ${where.join(" and ")}` : ""}
       order by created_at desc limit $${params.length}`,
      params,
    );
  }

  function worker(opts: Omit<WorkerOptions, "sql" | "schema" | "channel" | "listenUrl" | "log">) {
    const w = new Worker({ ...opts, sql, schema: schemaName, channel, listenUrl: options.listenUrl, log });
    workers.add(w);
    return w;
  }

  return {
    schema: schemaName,
    sql,
    workflow,
    migrate: () => migrate(sql, schemaName),
    start,
    publish,
    cancel,
    retry,
    getRun,
    listRuns,
    worker,
    /** Stops workers and closes the connection pool (if Kairos opened it). */
    async close() {
      await Promise.all([...workers].map((w) => w.stop()));
      if (ownsSql) await sql.end({ timeout: 5 });
    },
  };
}
