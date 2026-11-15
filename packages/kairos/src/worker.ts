import { hostname } from "node:os";
import postgres, { type Sql } from "postgres";
import {
  isKairosControl,
  KairosControl,
  NonDeterminismError,
  type SerializedError,
  StepFailedError,
  serializeError,
} from "./errors";
import {
  type Executor,
  finalizeCancelled,
  fromPostgres,
  hash,
  json,
  lockKey,
  newId,
  quoteSchema,
  roundTrip,
} from "./sql";
import type {
  Json,
  Logger,
  RunRow,
  StepInfo,
  StepOptions,
  StepRow,
  WaitOptions,
  WaitResult,
  Workflow,
  WorkflowContext,
} from "./types";

export type WorkerOptions = {
  sql: Sql;
  schema: string;
  channel: string;
  listenUrl?: string;
  log: Logger;
  // biome-ignore lint/suspicious/noExplicitAny: workflows of any input and output
  workflows: Workflow<any, any>[];
  /** Runs executing at once in this process. Default 20. */
  concurrency?: number;
  /** Runs one tenant may have executing at once, across all workers. Default 10. */
  tenantCap?: number;
  /** Fallback poll when no notification arrives. Default 1 s. */
  pollMs?: number;
  /** How long a claim lasts without a heartbeat. Default 30 s. */
  leaseMs?: number;
  /** A run that loses its worker this many times fails (a poison run). Default 5. */
  maxClaimLosses?: number;
  /** Finished runs and events are deleted after this many days. Default 30. */
  retentionDays?: number;
  /** On stop, how long to let running steps finish. Default 25 s (pm2 waits 30). */
  shutdownGraceMs?: number;
  /** Skip the maintenance loop (reaper, retention) in this process. */
  noMaintenance?: boolean;
};

type Claim = { run_id: string; attempt: number; workflow: string; version: number; db_now: Date };

const MAINTENANCE_EVERY_MS = 5_000;
/** Sleeps up to this long get a local timer to claim them when due (longer ones: the poll). */
const SHORT_SLEEP_MS = 5 * 60_000;
const RETENTION_EVERY_MS = 60_000;

/**
 * A worker process: claims due runs (any tenant, fairly), replays them until they finish, sleep or wait,
 * keeps its claims alive, and (one worker at a time) runs maintenance: freeing claims of dead workers,
 * failing poison runs and deleting old data.
 */
export class Worker {
  readonly id = newId("wkr");
  private readonly S: string;
  private readonly sql: Sql;
  private readonly pool: Executor;
  // biome-ignore lint/suspicious/noExplicitAny: see WorkerOptions
  private readonly workflows = new Map<string, Workflow<any, any>>();
  private readonly concurrency: number;
  private readonly tenantCap: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly active = new Map<string, Promise<void>>();
  private listener: Sql | null = null;
  private running = false;
  private stopping: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private wokenByNotify = false;
  /** A nudge that came while the loop was claiming: claim again instead of sleeping. */
  private nudged = false;
  private timers: NodeJS.Timeout[] = [];
  private lastRetention = 0;
  readonly stats = {
    claimed: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    suspended: 0,
    lostClaims: 0,
    wakesByNotify: 0,
    wakesByPoll: 0,
    wakesByNudge: 0,
    reclaimedByReaper: 0,
    infraRetries: 0,
  };

  constructor(private readonly opts: WorkerOptions) {
    this.S = quoteSchema(opts.schema);
    this.sql = opts.sql;
    this.pool = fromPostgres(opts.sql);
    for (const wf of opts.workflows) this.workflows.set(wf.key, wf);
    this.concurrency = opts.concurrency ?? 20;
    this.tenantCap = opts.tenantCap ?? 10;
    this.pollMs = opts.pollMs ?? 1_000;
    this.leaseMs = opts.leaseMs ?? 30_000;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.pool.query(
      `insert into ${this.S}.worker (id, host, pid, workflows, concurrency) values ($1, $2, $3, $4::text[], $5)`,
      [this.id, hostname(), process.pid, [...this.workflows.keys()], this.concurrency],
    );
    if (this.opts.listenUrl) {
      try {
        this.listener = postgres(this.opts.listenUrl, { max: 1, onnotice: () => {} });
        await this.listener.listen(this.opts.channel, () => {
          this.wokenByNotify = true;
          // Coalesce bursts: wake the loop at most every 100 ms.
          setTimeout(() => this.wake?.(), 100);
        });
      } catch (err) {
        this.opts.log("warn", "LISTEN unavailable, polling only", serializeError(err));
        this.listener = null;
      }
    }
    // Three heartbeats per lease, at most every 10 s, so a claim never lapses while its worker is alive.
    this.timers.push(setInterval(() => void this.heartbeat(), Math.min(10_000, this.leaseMs / 3)));
    if (!this.opts.noMaintenance)
      this.timers.push(setInterval(() => void this.maintenance(), MAINTENANCE_EVERY_MS));
    void this.loop();
  }

  /** Claim now: new work was just committed in this process. */
  nudge() {
    if (!this.running) return;
    this.stats.wakesByNudge++;
    this.kick();
  }

  /** Wakes the loop, or makes it claim again if it is claiming right now (never loses the wake). */
  private kick() {
    if (this.wake) this.wake();
    else this.nudged = true;
  }

  /** Stops claiming, lets running steps finish (up to the grace period), then gives back what's left. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.running = false;
      this.wake?.();
      for (const t of this.timers) clearInterval(t);
      const grace = this.opts.shutdownGraceMs ?? 25_000;
      await Promise.race([
        Promise.allSettled([...this.active.values()]),
        new Promise((r) => setTimeout(r, grace)),
      ]);
      try {
        await this.pool.query(
          `update ${this.S}.wakeup set claimed_by = null, claimed_until = null, wake_at = now() where claimed_by = $1`,
          [this.id],
        );
        await this.pool.query(
          `update ${this.S}.worker set stopped_at = now(), stats = $2::text::jsonb where id = $1`,
          [this.id, JSON.stringify(this.stats)],
        );
      } catch (err) {
        this.opts.log("warn", "could not release claims on stop", serializeError(err));
      }
      if (this.listener) await this.listener.end({ timeout: 2 }).catch(() => {});
    })();
    return this.stopping;
  }

  get busy() {
    return this.active.size;
  }

  private async loop() {
    while (this.running) {
      const free = this.concurrency - this.active.size;
      let got = 0;
      if (free > 0) {
        try {
          const claims = await this.claim(Math.min(free, 50));
          got = claims.length;
          for (const c of claims) this.spawn(c);
        } catch (err) {
          // 23505: two workers raced for one serial key; the loser just tries again.
          const code = (err as { code?: string }).code;
          if (code !== "23505") {
            this.opts.log("warn", "claim failed", serializeError(err));
            await sleep(this.pollMs);
          }
        }
      }
      if (got > 0 && got === Math.min(free, 50)) continue;
      if (this.nudged) {
        this.nudged = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.wake = null;
          this.stats.wakesByPoll++;
          resolve();
        }, this.pollMs);
        this.wake = () => {
          clearTimeout(t);
          this.wake = null;
          if (this.wokenByNotify) this.stats.wakesByNotify++;
          this.wokenByNotify = false;
          resolve();
        };
      });
    }
  }

  private spawn(c: Claim) {
    this.stats.claimed++;
    const p = this.execute(c)
      .catch((err) =>
        this.opts.log("error", "run execution crashed", { runId: c.run_id, ...serializeError(err) }),
      )
      .finally(() => {
        this.active.delete(c.run_id);
        // A slot and maybe a serial key (the chat) just freed up: claim what was waiting on them.
        this.kick();
      });
    this.active.set(c.run_id, p);
  }

  /**
   * One statement: due, unclaimed runs of the workflows this process knows, at most one per serial key
   * and none whose key is already executing, a fair slice per tenant up to its cap, locked with
   * SKIP LOCKED so workers never block each other.
   */
  private async claim(limit: number): Promise<Claim[]> {
    const S = this.S;
    return this.pool.query<Claim>(
      `with ready as (
         select w.run_id, w.tenant_id, w.serial_key, w.priority, w.wake_at
         from ${S}.wakeup w
         where w.claimed_by is null and w.wake_at <= now()
           and (w.workflow || '@' || w.version) = any($5::text[])
         order by w.wake_at
         limit 500
       ), free as (
         select r.*,
           row_number() over (partition by r.tenant_id, coalesce(r.serial_key, r.run_id) order by r.wake_at) as key_rn
         from ready r
         where r.serial_key is null or not exists (
           select 1 from ${S}.wakeup x
           where x.tenant_id = r.tenant_id and x.serial_key = r.serial_key and x.claimed_by is not null)
       ), ranked as (
         select f.*, row_number() over (partition by f.tenant_id order by f.priority desc, f.wake_at) as tenant_rn
         from free f where f.key_rn = 1
       ), busy as (
         select tenant_id, count(*)::int as n from ${S}.wakeup where claimed_by is not null group by tenant_id
       ), pick as (
         select r.run_id from ranked r left join busy b on b.tenant_id = r.tenant_id
         where r.tenant_rn <= greatest(0, $4::int - coalesce(b.n, 0))
         order by r.tenant_rn, r.priority desc, r.wake_at
         limit $2
       ), locked as (
         select w.run_id from ${S}.wakeup w
         where w.run_id in (select run_id from pick) and w.claimed_by is null and w.wake_at <= now()
         for update skip locked
       )
       update ${S}.wakeup w
       set claimed_by = $1, claimed_until = now() + ($3::double precision * interval '1 millisecond'),
           attempt = w.attempt + 1
       from locked l where w.run_id = l.run_id
       returning w.run_id, w.attempt, w.workflow, w.version, now() as db_now`,
      [this.id, limit, this.leaseMs, this.tenantCap, [...this.workflows.keys()]],
    );
  }

  private async execute(c: Claim) {
    const wf = this.workflows.get(`${c.workflow}@${c.version}`);
    if (!wf) return; // not ours (the claim filter makes this impossible)
    const exec = new Execution(this, c, wf);
    await exec.run();
  }

  private async heartbeat() {
    try {
      const ids = [...this.active.keys()];
      if (ids.length)
        await this.pool.query(
          `update ${this.S}.wakeup set claimed_until = now() + ($3::double precision * interval '1 millisecond')
           where claimed_by = $1 and run_id = any($2::text[])`,
          [this.id, ids, this.leaseMs],
        );
      await this.pool.query(
        `update ${this.S}.worker set heartbeat_at = now(), stats = $2::text::jsonb where id = $1`,
        [this.id, JSON.stringify({ ...this.stats, busy: this.active.size })],
      );
    } catch (err) {
      this.opts.log("warn", "heartbeat failed", serializeError(err));
    }
  }

  /** Only one worker runs each tick (a transaction-scoped lock, so it works through PgBouncer). */
  private async maintenance() {
    const S = this.S;
    try {
      await this.sql.begin(async (tx) => {
        const ex = fromPostgres(tx);
        const [lock] = await ex.query<{ ok: boolean }>("select pg_try_advisory_xact_lock($1::bigint) as ok", [
          lockKey(`kairos:maintenance:${this.opts.schema}`),
        ]);
        if (!lock?.ok) return;
        // Claims whose worker stopped heartbeating go back to the queue.
        const freed = await ex.query<{ id: string; claim_losses: number }>(
          `with expired as (
             select run_id from ${S}.wakeup where claimed_by is not null and claimed_until < now()
             order by claimed_until limit 500 for update skip locked
           ), freed as (
             update ${S}.wakeup w set claimed_by = null, claimed_until = null, wake_at = now()
             from expired e where w.run_id = e.run_id returning w.run_id
           )
           update ${S}.run r set claim_losses = r.claim_losses + 1, status = 'queued', updated_at = now()
           from freed f where r.id = f.run_id returning r.id, r.claim_losses`,
        );
        this.stats.reclaimedByReaper += freed.length;
        const poison = freed
          .filter((f) => f.claim_losses >= (this.opts.maxClaimLosses ?? 5))
          .map((f) => f.id);
        if (poison.length) {
          await ex.query(`delete from ${S}.wakeup where run_id = any($1::text[]) and claimed_by is null`, [
            poison,
          ]);
          await ex.query(
            `update ${S}.run set status = 'failed', finished_at = now(), updated_at = now(), error = $2::text::jsonb
             where id = any($1::text[])`,
            [
              poison,
              JSON.stringify({
                name: "ClaimLost",
                message: "The run lost its worker too many times (it may crash or hang the process).",
                nonRetryable: true,
              }),
            ],
          );
          await ex.query(
            `update ${S}.wait set status = 'cancelled', resolved_at = now() where run_id = any($1::text[]) and status = 'open'`,
            [poison],
          );
          this.opts.log("warn", "failed poison runs", poison);
        }
        if (Date.now() - this.lastRetention > RETENTION_EVERY_MS) {
          this.lastRetention = Date.now();
          const days = this.opts.retentionDays ?? 30;
          await ex.query(
            `delete from ${S}.run where id in (
               select id from ${S}.run where finished_at < now() - ($1::int * interval '1 day') limit 1000)`,
            [days],
          );
          await ex.query(
            `delete from ${S}.event where id in (
               select id from ${S}.event where created_at < now() - ($1::int * interval '1 day') limit 5000)`,
            [days],
          );
          await ex.query(`delete from ${S}.worker where heartbeat_at < now() - interval '1 day'`);
        }
      });
    } catch (err) {
      this.opts.log("warn", "maintenance failed", serializeError(err));
    }
  }

  /** Internals for Execution. */
  get internals() {
    return {
      S: this.S,
      sql: this.sql,
      pool: this.pool,
      log: this.opts.log,
      stats: this.stats,
      id: this.id,
      wakeIn: (ms: number) => this.wakeIn(ms),
    };
  }

  /**
   * A run here just went to sleep for a short while: claim again when it's due instead of at the
   * next poll, so a 1.5 s pause is 1.5 s, not up to a poll later. (Another worker may take it; fine.)
   */
  private wakeIn(ms: number) {
    if (!this.running || ms > SHORT_SLEEP_MS) return;
    const t = setTimeout(() => this.kick(), Math.max(0, ms) + 15);
    t.unref?.();
  }
}

/** One claim of one run: replay the handler from the top, recording new steps as they happen. */
class Execution implements WorkflowContext {
  runId: string;
  tenantId = "";
  workflow: string;
  version: number;
  labels: Record<string, Json> = {};
  private seq = 0;
  private steps = new Map<number, StepRow>();
  /** When the previous ctx call began (Postgres time), for wait lookback. */
  private lastStartedAt: Date | null = null;
  /** Postgres clock minus this process's clock, measured at claim time. */
  private readonly clockOffset: number;
  private runCreatedAt: Date | null = null;
  /** Set once the run stopped executing here (slept, started waiting, lost its claim, cancelled). */
  private stopped: KairosControl["kind"] | null = null;
  private readonly S: string;
  private readonly w: Worker["internals"];

  constructor(
    worker: Worker,
    private readonly claim: Claim,
    // biome-ignore lint/suspicious/noExplicitAny: see WorkerOptions
    private readonly wf: Workflow<any, any>,
  ) {
    this.w = worker.internals;
    this.S = this.w.S;
    this.runId = claim.run_id;
    this.workflow = wf.name;
    this.version = wf.version;
    this.clockOffset = new Date(claim.db_now).getTime() - Date.now();
  }

  private dbNow() {
    return new Date(Date.now() + this.clockOffset);
  }

  async run() {
    const { S } = this;
    const [run] = await this.w.pool.query<RunRow>(
      `update ${S}.run set status = 'running', started_at = coalesce(started_at, now()), claims = claims + 1,
         updated_at = now() where id = $1 returning *`,
      [this.runId],
    );
    if (!run) {
      await this.w.pool.query(`delete from ${S}.wakeup where run_id = $1`, [this.runId]);
      return;
    }
    this.tenantId = run.tenant_id;
    this.labels = run.labels ?? {};
    this.runCreatedAt = run.created_at;
    if (run.cancel_requested_at) {
      // The fenced write notices the request and finishes the cancellation.
      await this.write(async () => null).catch(() => {});
      return;
    }
    const rows = await this.w.pool.query<StepRow>(`select * from ${S}.step where run_id = $1 order by seq`, [
      this.runId,
    ]);
    for (const r of rows) this.steps.set(r.seq, r);

    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await this.wf.handler(this, run.input) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (this.stopped) return; // already suspended, lost or cancelled, even if the handler swallowed it
    if (!outcome.ok && isKairosControl(outcome.error)) return;

    try {
      if (outcome.ok) {
        await this.write(async (ex) => {
          await ex.query(`delete from ${S}.wakeup where run_id = $1`, [this.runId]);
          await ex.query(
            `update ${S}.run set status = 'completed', output = $2::text::jsonb, finished_at = now(), updated_at = now()
             where id = $1`,
            [this.runId, json(outcome.value)],
          );
          await this.closeOpenWaits(ex);
        });
        this.w.stats.completed++;
      } else {
        await this.fail(serializeError(outcome.error));
      }
    } catch (err) {
      if (!isKairosControl(err)) throw err;
    }
  }

  private async fail(error: SerializedError) {
    const { S } = this;
    await this.write(async (ex) => {
      await ex.query(`delete from ${S}.wakeup where run_id = $1`, [this.runId]);
      await ex.query(
        `update ${S}.run set status = 'failed', error = $2::text::jsonb, finished_at = now(), updated_at = now() where id = $1`,
        [this.runId, JSON.stringify(error)],
      );
      await this.closeOpenWaits(ex);
    });
    this.w.stats.failed++;
  }

  private closeOpenWaits(ex: Executor) {
    return ex.query(
      `update ${this.S}.wait set status = 'cancelled', resolved_at = now() where run_id = $1 and status = 'open'`,
      [this.runId],
    );
  }

  /**
   * Every write after the claim goes through here: it first checks (and locks) that this worker still
   * holds this exact claim, and honours a cancel request. Anything else means another worker owns the
   * run now, so nothing is written.
   */
  private async tx<T>(fn: (ex: Executor) => Promise<T>, lock?: string): Promise<T> {
    if (this.stopped) throw new KairosControl(this.stopped);
    const { S } = this;
    try {
      return (await this.w.sql.begin(async (t) => {
        const ex = fromPostgres(t);
        // An event lock always comes before the run's row lock (the order publish() uses), or the two
        // could deadlock.
        if (lock) await ex.query("select pg_advisory_xact_lock($1::bigint)", [lockKey(lock)]);
        const [fence] = await ex.query<{ cancel_requested_at: Date | null }>(
          `select r.cancel_requested_at from ${S}.wakeup w join ${S}.run r on r.id = w.run_id
           where w.run_id = $1 and w.claimed_by = $2 and w.attempt = $3 for update of w`,
          [this.runId, this.w.id, this.claim.attempt],
        );
        if (!fence) throw new KairosControl("lost");
        if (fence.cancel_requested_at) {
          await ex.query(`delete from ${S}.wakeup where run_id = $1`, [this.runId]);
          await finalizeCancelled(ex, S, this.runId);
          return { __cancelled: true } as T;
        }
        return fn(ex);
      })) as T;
    } catch (err) {
      if (isKairosControl(err)) {
        this.stop(err.kind);
        throw err;
      }
      // Kairos's own write failed (deadlock, connection lost, …): that is not the workflow's fault, so
      // the run is not failed. Hand it back to run again shortly; if even that fails the lease expires.
      this.w.stats.infraRetries++;
      this.w.log("warn", "write failed, the run will retry", { runId: this.runId, ...serializeError(err) });
      await this.w.pool
        .query(
          `update ${S}.wakeup set claimed_by = null, claimed_until = null, wake_at = now() + interval '1 second'
           where run_id = $1 and claimed_by = $2 and attempt = $3`,
          [this.runId, this.w.id, this.claim.attempt],
        )
        .catch(() => {});
      this.stop("lost");
      throw new KairosControl("lost");
    }
  }

  private stop(kind: KairosControl["kind"]) {
    if (this.stopped) return;
    this.stopped = kind;
    if (kind === "lost") this.w.stats.lostClaims++;
    if (kind === "cancelled") this.w.stats.cancelled++;
    if (kind === "suspended") this.w.stats.suspended++;
  }

  /** Runs a fenced write; a cancellation discovered there stops the run. */
  private async write<T>(fn: (ex: Executor) => Promise<T>, lock?: string): Promise<T> {
    const out = await this.tx(fn, lock);
    if (out && typeof out === "object" && "__cancelled" in (out as object)) {
      this.stop("cancelled");
      throw new KairosControl("cancelled");
    }
    return out;
  }

  /** Releases the claim with a wake time; the run continues later on any worker. */
  private async suspendIn(ex: Executor, wakeSql: string, wakeParams: unknown[], status: string) {
    const { S } = this;
    await ex.query(
      `update ${S}.wakeup set claimed_by = null, claimed_until = null, wake_at = ${wakeSql} where run_id = $1`,
      [this.runId, ...wakeParams],
    );
    await ex.query(`update ${S}.run set status = $2, updated_at = now() where id = $1`, [this.runId, status]);
  }

  private next(kind: StepRow["kind"], name: string, extra: unknown[] = []) {
    if (this.stopped) throw new KairosControl(this.stopped);
    const seq = ++this.seq;
    const idem = hash([kind, name, ...extra]);
    const row = this.steps.get(seq);
    if (row && (row.kind !== kind || row.idem_hash !== idem))
      throw new NonDeterminismError(
        `Step ${seq} was recorded as ${row.kind} "${row.name}" but the code now asks for ${kind} "${name}". ` +
          "Changed workflows need a new version.",
      );
    return { seq, idem, row };
  }

  private done(row: StepRow) {
    this.lastStartedAt = new Date(row.started_at);
  }

  private async saveStep(
    ex: Executor,
    s: {
      seq: number;
      kind: StepRow["kind"];
      name: string;
      idem: string;
      status: StepRow["status"];
      result?: unknown;
      error?: unknown;
      attempt: number;
      startedAt?: Date;
    },
  ): Promise<StepRow> {
    const [row] = await ex.query<StepRow>(
      `insert into ${this.S}.step (run_id, seq, kind, name, idem_hash, status, result, error, attempt, completed_at, started_at)
       values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9, case when $6 in ('completed','failed') then now() end,
         coalesce($10::timestamptz, now()))
       on conflict (run_id, seq) do update set status = excluded.status, result = excluded.result,
         error = excluded.error, attempt = excluded.attempt, completed_at = excluded.completed_at
       returning *`,
      [
        this.runId,
        s.seq,
        s.kind,
        s.name,
        s.idem,
        s.status,
        json(s.result),
        json(s.error),
        s.attempt,
        s.startedAt?.toISOString() ?? null,
      ],
    );
    if (!row) throw new Error("step not saved");
    this.steps.set(s.seq, row);
    return row;
  }

  // ---- WorkflowContext ----

  async step<T>(name: string, fn: (info: StepInfo) => Promise<T> | T, options: StepOptions = {}): Promise<T> {
    const { seq, idem, row } = this.next("step", name);
    if (row?.status === "completed") {
      this.done(row);
      return row.result as T;
    }
    if (row?.status === "failed") {
      this.done(row);
      throw new StepFailedError(name, row.error as SerializedError);
    }
    const attempt = (row?.attempt ?? 0) + 1;
    const retries = options.retries ?? this.wf.retries;
    const timeoutMs = options.timeoutMs ?? this.wf.stepTimeoutMs;
    const startedAt = this.dbNow();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let value: T;
    try {
      value = await Promise.race([
        Promise.resolve().then(() =>
          fn({ idempotencyKey: `${this.runId}:${seq}`, attempt, signal: controller.signal }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              Object.assign(new Error(`Step "${name}" timed out after ${timeoutMs} ms`), { code: "TIMEOUT" }),
            );
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      if (isKairosControl(err)) throw err;
      const error = serializeError(err);
      const backoff = { ...this.wf.backoff, ...options.backoff };
      if (!error.nonRetryable && attempt <= retries) {
        const delay = Math.min(backoff.maxMs, backoff.baseMs * backoff.factor ** (attempt - 1));
        const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
        await this.write(async (ex) => {
          await this.saveStep(ex, {
            seq,
            kind: "step",
            name,
            idem,
            status: "retrying",
            error,
            attempt,
            startedAt,
          });
          await this.suspendIn(
            ex,
            "now() + ($2::double precision * interval '1 millisecond')",
            [jittered],
            "queued",
          );
        });
        this.stop("suspended");
        throw new KairosControl("suspended");
      }
      const saved = await this.write((ex) =>
        this.saveStep(ex, { seq, kind: "step", name, idem, status: "failed", error, attempt, startedAt }),
      );
      this.done(saved);
      throw new StepFailedError(name, error);
    } finally {
      clearTimeout(timer);
    }
    const result = roundTrip(value);
    const saved = await this.write((ex) =>
      this.saveStep(ex, { seq, kind: "step", name, idem, status: "completed", result, attempt, startedAt }),
    );
    this.done(saved);
    return result;
  }

  sleepUntil(name: string, until: Date): Promise<void> {
    return this.sleepInternal(name, { until });
  }

  sleep(name: string, ms: number): Promise<void> {
    return this.sleepInternal(name, { ms });
  }

  private async sleepInternal(name: string, at: { ms?: number; until?: Date }) {
    const { seq, idem, row } = this.next("sleep", name);
    if (row?.status === "completed") {
      this.done(row);
      return;
    }
    const { S } = this;
    const finished = await this.write(async (ex) => {
      if (!row) {
        // The wake time is computed by Postgres once and stored, so replays agree on it.
        await ex.query(
          `insert into ${S}.step (run_id, seq, kind, name, idem_hash, status, wake_at)
           values ($1, $2, 'sleep', $3, $4, 'waiting',
             coalesce($5::timestamptz, now() + ($6::double precision * interval '1 millisecond')))`,
          [this.runId, seq, name, idem, at.until?.toISOString() ?? null, Math.max(0, at.ms ?? 0)],
        );
      }
      const [due] = await ex.query<StepRow>(
        `update ${S}.step set status = 'completed', completed_at = now()
         where run_id = $1 and seq = $2 and wake_at <= now() returning *`,
        [this.runId, seq],
      );
      if (due) {
        this.steps.set(seq, due);
        return due;
      }
      await this.suspendIn(
        ex,
        `(select wake_at from ${S}.step where run_id = $1 and seq = $2)`,
        [seq],
        "sleeping",
      );
      return null;
    });
    if (finished) {
      this.done(finished);
      return;
    }
    const wakeAt = row?.wake_at
      ? new Date(row.wake_at).getTime() - this.clockOffset
      : at.until
        ? at.until.getTime()
        : Date.now() + (at.ms ?? 0);
    this.w.wakeIn(wakeAt - Date.now());
    this.stop("suspended");
    throw new KairosControl("suspended");
  }

  async waitForEvent<P = Json>(name: string, o: WaitOptions): Promise<WaitResult<P>> {
    const scope = o.scope ?? "";
    const { seq, idem, row } = this.next("wait", name, [o.key, scope, o.filter ?? null]);
    if (row?.status === "completed") {
      this.done(row);
      return row.result as WaitResult<P>;
    }
    const { S } = this;
    let from: StepRow | undefined;
    if (o.lookbackFrom)
      for (const s of this.steps.values())
        if (s.name === o.lookbackFrom && (!from || s.seq > from.seq)) from = s;
    const since = (from ? new Date(from.started_at) : null) ?? this.lastStartedAt ?? this.runCreatedAt;
    const result = await this.write(
      async (ex): Promise<WaitResult<P> | null> => {
        // publish() takes the same lock, so an event is either seen here or matches the wait we register.
        let event: { id: string; key: string; scope: string; payload: P; created_at: Date } | undefined;
        if (!row) {
          // Lookback: an event published since the previous step began (e.g. a reply that arrived while the
          // question was being sent) counts, unless this run already used it.
          [event] = await ex.query(
            `select id, key, scope, payload, created_at from ${S}.event e
           where e.tenant_id = $1 and e.key = $2 and e.scope = $3 and e.created_at > $4::timestamptz
             and ($5::text::jsonb is null or coalesce(e.payload, 'null'::jsonb) @> $5::text::jsonb)
             and not exists (select 1 from ${S}.wait w where w.run_id = $6 and w.event_id = e.id)
           order by e.created_at, e.id limit 1`,
            [
              this.tenantId,
              o.key,
              scope,
              since?.toISOString() ?? new Date(0).toISOString(),
              json(o.filter),
              this.runId,
            ],
          );
          await ex.query(
            `insert into ${S}.wait (id, run_id, seq, tenant_id, event_key, scope, filter, deadline, status, event_id, resolved_at)
           values ($1, $2, $3, $4, $5, $6, $7::text::jsonb,
             case when $8::double precision is null then null else now() + ($8::double precision * interval '1 millisecond') end,
             $9, $10, case when $10::text is null then null else now() end)`,
            [
              newId("wait"),
              this.runId,
              seq,
              this.tenantId,
              o.key,
              scope,
              json(o.filter),
              o.timeoutMs ?? null,
              event ? "matched" : "open",
              event?.id ?? null,
            ],
          );
        } else {
          const [w] = await ex.query<{ status: string; event_id: string | null; due: boolean }>(
            `select status, event_id, (deadline is not null and deadline <= now()) as due
           from ${S}.wait where run_id = $1 and seq = $2 for update`,
            [this.runId, seq],
          );
          if (w?.status === "matched" && w.event_id) {
            [event] = await ex.query(
              `select id, key, scope, payload, created_at from ${S}.event where id = $1`,
              [w.event_id],
            );
          } else if (w?.status === "open" && w.due) {
            await ex.query(
              `update ${S}.wait set status = 'timed_out', resolved_at = now() where run_id = $1 and seq = $2`,
              [this.runId, seq],
            );
            const out: WaitResult<P> = { timedOut: true };
            const saved = await this.saveStep(ex, {
              seq,
              kind: "wait",
              name,
              idem,
              status: "completed",
              result: out,
              attempt: 1,
            });
            this.done(saved);
            return out;
          }
        }
        if (event) {
          const out: WaitResult<P> = {
            timedOut: false,
            event: {
              id: event.id,
              key: event.key,
              scope: event.scope,
              payload: event.payload,
              createdAt: new Date(event.created_at).toISOString(),
            },
          };
          const saved = await this.saveStep(ex, {
            seq,
            kind: "wait",
            name,
            idem,
            status: "completed",
            result: out,
            attempt: 1,
          });
          this.done(saved);
          return out;
        }
        if (!row) await this.saveStep(ex, { seq, kind: "wait", name, idem, status: "waiting", attempt: 1 });
        await this.suspendIn(
          ex,
          `coalesce((select deadline from ${S}.wait where run_id = $1 and seq = $2), 'infinity'::timestamptz)`,
          [seq],
          "waiting",
        );
        return null;
      },
      `${this.w.S.replaceAll('"', "")}:${this.tenantId}:${o.key}:${scope}`,
    );
    if (result) return roundTrip(result);
    this.stop("suspended");
    throw new KairosControl("suspended");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
