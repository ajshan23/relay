# Kairos

Durable runs on Postgres. No Redis, no Temporal, no extra servers.

A **run** is an async function that survives crashes, deploys and long waits. It calls:

- `ctx.step(name, fn)` to do something once and record the result;
- `ctx.sleep(name, ms)` to pause for minutes or weeks;
- `ctx.waitForEvent(name, { key, scope, timeoutMs })` to wait for something to happen, such as a customer's reply.

Every call is written to a step log. When a run sleeps or waits, the process lets go of it, and all that's left is one small row. When it's due, or the event arrives, any worker picks it up and **replays** the function. Finished steps return their saved results instead of running again.

```ts
import { createKairos } from "@relay/kairos";

const kairos = createKairos({ databaseUrl, listenUrl /* optional direct URL */ });
await kairos.migrate();

const welcome = kairos.workflow({ name: "welcome", version: 1 }, async (ctx, input: { chat: string }) => {
  await ctx.step("ask", ({ idempotencyKey }) => sendQuestion(input.chat, idempotencyKey));
  const reply = await ctx.waitForEvent("answer", {
    key: "message.received",
    scope: input.chat,
    timeoutMs: 24 * 3600_000,
  });
  if (reply.timedOut) return ctx.step("nudge", () => sendNudge(input.chat));
  await ctx.step("save", () => saveAnswer(input.chat, reply.event.payload));
});

await kairos.worker({ workflows: [welcome] }).start();
await kairos.start(welcome, { chat: "c1" }, { tenantId: "org_1", serialKey: "c1" });
await kairos.publish({ tenantId: "org_1", key: "message.received", scope: "c1", payload: { text: "yes" } });
```

## Guarantees

- **A finished step never runs again.** Its result is saved before the function continues.
- **A step interrupted by a crash runs again** (at least once). `ctx.step` passes a stable `idempotencyKey` (`runId:seq`) that you give to outside APIs, so a retry never sends twice.
- **One run at a time per serial key** (per tenant), even with many workers. Use a conversation id.
- **Fair between tenants.** Each claim takes a slice from every tenant with ready work, up to `tenantCap` runs in flight per tenant.
- **An event can't slip past a wait.** Publishing and registering a wait take the same lock. A wait also looks back for events published since the previous step began, so a reply that arrives while the question is still being sent counts. A run never uses the same event twice.
- **Runs are pinned to `workflow@version`.** A worker only claims versions it registers. Keep the old version registered until `listRuns({ workflow, status: [...] })` shows none left. There are no patch markers.
- **Changed code is caught.** Each step stores a hash of its kind, name and wait settings. On replay, a mismatch fails the run with `NonDeterminismError` instead of carrying on wrongly.
- **Stale workers can't write.** Every write checks the worker still holds the exact claim. A run whose worker dies is picked up elsewhere once its lease (30 s) runs out. A run that kills its worker 5 times fails as a poison run.
- **Engine errors don't fail runs.** If a Kairos write hits a deadlock or a lost connection, the run is handed back to run again. Only the workflow's own errors fail a run.
- **Clocks come from Postgres.** Workers' clocks don't matter.

## Errors and retries

- **Retries.** A step that throws is retried `retries` times (default 3), with backoff `min(maxMs, baseMs·factor^n)` ±20%.
- **Hard failures.** Throw `NonRetryableError` to fail a step at once.
- **When retries run out,** the function gets a `StepFailedError`. Catch it to take another path, or let it fail the run.
- **Timeouts.** A step attempt that runs past `timeoutMs` (default 60 s) counts as failed, and its `signal` is aborted.
- **Catching broadly.** If your function catches errors broadly, rethrow `isKairosControl(e)` errors: they are how Kairos pauses a run.
- **Cancel and retry.** `kairos.cancel(runId)` stops a run immediately, or at its next step if it's running. `kairos.retry(runId)` re-runs a failed run from the failed step.

## Transactions

`start`, `publish` and `cancel` accept `{ executor }` so they can join your own database transaction. A run then only exists if your change commits. This replaces a separate outbox table. An executor is any `{ query(text, params) }`.

## Operating it

- **Schema.** Kairos uses its own schema (`kairos` by default) and migrates it itself. `migrate()` is safe to run from every process at startup.
- **Pooled URLs work** (PgBouncer, Neon `-pooler`), because every lock is transaction-scoped. Give `listenUrl` a direct URL to wake workers in milliseconds. Without it, workers poll every `pollMs` (1 s).
- **Maintenance needs no leader.** Every 5 s one worker (whoever gets a transaction lock) frees dead claims and fails poison runs. Every minute it deletes finished runs and events older than `retentionDays` (30).
- **Shutdown.** `worker.stop()` stops claiming, waits up to 25 s for running steps, and hands back what's left.

## Measured (local Postgres 17 in Docker, Apple Silicon laptop)

`pnpm chaos` runs 10,000 runs on 5 worker processes. Each run has steps, sleeps, waits and replies (some sent before the run is waiting), and every 50th run has a flaky step. Runs share 150 serial keys across 7 tenants. A random worker is killed with `SIGKILL` every 3 s.

| Check                                            | Result                                       |
| ------------------------------------------------ | -------------------------------------------- |
| Runs completed                                   | 10,000 of 10,000 (0 failed, 0 stuck) in 49 s |
| Workers killed / claims reaped                   | 11 / 130                                     |
| Steps re-executed because a worker died mid-step | 39 of 20,000                                 |
| Overlapping executions of one serial key         | 0                                            |
| Wrong results                                    | 0                                            |

`pnpm load`:

| Measure                                  | Result                                          |
| ---------------------------------------- | ----------------------------------------------- |
| Throughput (2 workers, 5 steps per run)  | 2,361 steps/s, 472 runs/s                       |
| Starting runs                            | about 1,080/s                                   |
| 100,000 runs parked (sleeping)           | idle worker CPU 0.15%; ready-queue scan 0.04 ms |
| Event → run finished, with LISTEN        | p50 16 ms, p95 71 ms                            |
| Event → run finished, polling only (1 s) | p50 621 ms, p95 985 ms                          |

## Tests

`pnpm test` runs 18 tests against a throwaway database: `KAIROS_TEST_DATABASE_URL`, default `postgres://relay:relay@localhost:5544/kairos_test`, the repo's Docker Postgres. Each test file uses its own schema and drops it afterwards. Never point tests, `chaos` or `load` at a real database.

Credits for the design ideas are in [NOTICE.md](./NOTICE.md).
