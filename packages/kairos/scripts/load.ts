import postgres from "postgres";
import { createKairos, fromPostgres, type Kairos } from "../src/index";

/*
 * Load test (throwaway local Postgres only). Three measurements:
 *   1. throughput: RUNS runs × 5 steps on two workers → steps per second
 *   2. parked:     PARKED runs sleeping for an hour → how long a claim takes and how busy an idle worker is
 *   3. wake:       WAITERS runs waiting for an event, then one event each → publish-to-done latency,
 *                  with LISTEN and with polling only
 * Usage: pnpm --filter @relay/kairos load
 */
const url = process.env.KAIROS_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/kairos_test";
const RUNS = Number(process.env.RUNS ?? 4000);
const PARKED = Number(process.env.PARKED ?? 100_000);
const WAITERS = Number(process.env.WAITERS ?? 300);
const SCHEMA = "kairos_load";

const admin = postgres(url, { max: 2, onnotice: () => {} });
await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`);
const S = `"${SCHEMA}"`;
const report: Record<string, unknown> = {};

async function fresh(listen: boolean): Promise<Kairos> {
  const k = createKairos({
    databaseUrl: url,
    listenUrl: listen ? url : undefined,
    schema: SCHEMA,
    maxConnections: 20,
    log: () => {},
  });
  await k.migrate();
  return k;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0);
};

// 1. Throughput
{
  const k = await fresh(true);
  const wf = k.workflow({ name: "load", version: 1 }, async (ctx, input: { i: number }) => {
    let acc = input.i;
    for (let s = 0; s < 5; s++) acc = await ctx.step(`s${s}`, () => acc + 1);
    return acc;
  });
  const workers = [0, 1].map(() =>
    k.worker({ workflows: [wf], concurrency: 50, tenantCap: 100, pollMs: 200 }),
  );
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i += 500) {
    await k.sql.begin(async (tx) => {
      const ex = fromPostgres(tx);
      for (let j = i; j < Math.min(RUNS, i + 500); j++)
        await k.start(wf, { i: j }, { tenantId: `t${j % 10}`, executor: ex });
    });
  }
  const enqueueMs = Date.now() - t0;
  const t1 = Date.now();
  await Promise.all(workers.map((w) => w.start()));
  for (;;) {
    const [r] = await admin.unsafe<{ n: string }[]>(
      `select count(*) n from ${S}.run where status <> 'completed'`,
    );
    if (Number(r?.n) === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const ms = Date.now() - t1;
  await Promise.all(workers.map((w) => w.stop()));
  report.throughput = {
    runs: RUNS,
    stepsPerRun: 5,
    startsPerSecond: Math.round(RUNS / (enqueueMs / 1000)),
    seconds: +(ms / 1000).toFixed(1),
    runsPerSecond: Math.round(RUNS / (ms / 1000)),
    stepsPerSecond: Math.round((RUNS * 5) / (ms / 1000)),
  };
  console.log("throughput", report.throughput);
  await k.close();
  await admin.unsafe(`drop schema ${SCHEMA} cascade`);
}

// 2. Parked runs + 3. wake latency
for (const listen of [true, false]) {
  const k = await fresh(listen);
  const park = k.workflow({ name: "park", version: 1 }, async () => "never");
  const waiter = k.workflow({ name: "waiter", version: 1 }, async (ctx, input: { i: number }) => {
    const r = await ctx.waitForEvent("w", { key: "ping", scope: `w-${input.i}`, timeoutMs: 600_000 });
    return r.timedOut ? "timeout" : "ok";
  });

  if (listen) {
    const t0 = Date.now();
    for (let i = 0; i < PARKED; i += 2000) {
      await k.sql.begin(async (tx) => {
        const ex = fromPostgres(tx);
        for (let j = i; j < Math.min(PARKED, i + 2000); j++)
          await k.start(park, {}, { tenantId: `t${j % 50}`, delayMs: 3_600_000, executor: ex });
      });
    }
    report.parked = { runs: PARKED, insertSeconds: +((Date.now() - t0) / 1000).toFixed(1) };
    await admin.unsafe(`analyze ${S}.wakeup`);
  }

  const w = k.worker({ workflows: [park, waiter], concurrency: 50, tenantCap: 100, pollMs: 1000 });
  await w.start();
  const starts = await Promise.all(
    Array.from({ length: WAITERS }, (_, i) => k.start(waiter, { i }, { tenantId: `t${i % 10}` })),
  );
  for (;;) {
    const [r] = await admin.unsafe<{ n: string }[]>(
      `select count(*) n from ${S}.run where workflow = 'waiter' and status <> 'waiting'`,
    );
    if (Number(r?.n) === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (listen) {
    // Idle cost with PARKED sleeping runs: CPU of this process over 10 s, and the claim query's plan time.
    const cpu0 = process.cpuUsage();
    await new Promise((r) => setTimeout(r, 10_000));
    const cpu = process.cpuUsage(cpu0);
    const plan = await admin.unsafe<{ "QUERY PLAN": string }[]>(
      `explain analyze select run_id from ${S}.wakeup where claimed_by is null and wake_at <= now() order by wake_at limit 500`,
    );
    (report.parked as Record<string, unknown>).idleWorkerCpuPercent = +(
      ((cpu.user + cpu.system) / 1e6 / 10) *
      100
    ).toFixed(2);
    (report.parked as Record<string, unknown>).readyScan = plan
      .map((p) => p["QUERY PLAN"])
      .find((l) => l.startsWith("Execution Time"));
  }

  // Publish one event per waiter, a few at a time, then measure event → run completed.
  for (let i = 0; i < WAITERS; i++) {
    await k.publish({ tenantId: `t${i % 10}`, key: "ping", scope: `w-${i}` });
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 20));
  }
  for (;;) {
    const [r] = await admin.unsafe<{ n: string }[]>(
      `select count(*) n from ${S}.run where workflow = 'waiter' and status <> 'completed'`,
    );
    if (Number(r?.n) === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const lat = await admin.unsafe<{ ms: number }[]>(
    `select extract(epoch from (r.finished_at - e.created_at)) * 1000 as ms
     from ${S}.run r join ${S}.wait w on w.run_id = r.id join ${S}.event e on e.id = w.event_id
     where r.workflow = 'waiter'`,
  );
  const ms = lat.map((l) => Number(l.ms));
  report[listen ? "wakeWithListen" : "wakePollingOnly"] = {
    waiters: WAITERS,
    p50Ms: pct(ms, 50),
    p95Ms: pct(ms, 95),
    maxMs: pct(ms, 100),
  };
  console.log(
    listen ? "wake (LISTEN)" : "wake (poll 1 s)",
    report[listen ? "wakeWithListen" : "wakePollingOnly"],
  );
  void starts;
  await w.stop();
  await k.close();
  if (!listen) await admin.unsafe(`drop schema ${SCHEMA} cascade`);
  else await admin.unsafe(`delete from ${S}.run where workflow = 'waiter'`);
}

console.log(JSON.stringify(report, null, 2));
await admin.end();
