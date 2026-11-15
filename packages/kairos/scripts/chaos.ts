import { type ChildProcess, spawn } from "node:child_process";
import postgres from "postgres";
import { createKairos } from "../src/index";
import { CHAOS_SCHEMA, chaosWorkflow } from "./chaos-workflow";

/*
 * Chaos test: WORKERS processes run RUNS runs (steps, sleeps, waits, retries, shared serial keys) while
 * one random worker is killed with SIGKILL every KILL_EVERY_MS. Afterwards it checks:
 *   - every run completed (none failed, none stuck)
 *   - no two executions of one serial key overlapped
 *   - steps re-ran only because a worker died mid-step (counted, and bounded by kills × concurrency)
 * Usage: pnpm --filter @relay/kairos chaos   (throwaway local Postgres only)
 */
const url = process.env.KAIROS_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/kairos_test";
const RUNS = Number(process.env.RUNS ?? 3000);
const WORKERS = Number(process.env.WORKERS ?? 5);
const KILL_EVERY_MS = Number(process.env.KILL_EVERY_MS ?? 3000);
const CONVS = Number(process.env.CONVS ?? 150);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 600_000);

const sql = postgres(url, { max: 4, onnotice: () => {} });
await sql.unsafe(`drop schema if exists ${CHAOS_SCHEMA} cascade; drop schema if exists chaos cascade;`);
await sql.unsafe(`create schema chaos;
  create table chaos.effect (id bigint generated always as identity primary key, run_id text, step text,
    conv text, pid int, started_at timestamptz, ended_at timestamptz);`);
const k = createKairos({ databaseUrl: url, schema: CHAOS_SCHEMA, log: () => {} });
await k.migrate();
const wf = chaosWorkflow(k, url);

const children = new Set<ChildProcess>();
const spawnWorker = () => {
  const c = spawn(
    process.execPath,
    ["--import", "tsx", new URL("./chaos-worker.ts", import.meta.url).pathname],
    {
      stdio: ["ignore", "ignore", "inherit"],
      env: process.env,
    },
  );
  children.add(c);
  c.on("exit", () => children.delete(c));
};
for (let i = 0; i < WORKERS; i++) spawnWorker();

const started = Date.now();
const ids: string[] = [];
for (let i = 0; i < RUNS; i += 200) {
  const batch = await Promise.all(
    Array.from({ length: Math.min(200, RUNS - i) }, (_, j) =>
      k.start(
        wf,
        { i: i + j, conv: `conv-${(i + j) % CONVS}` },
        {
          tenantId: `tenant-${((i + j) % CONVS) % 7}`,
          serialKey: `conv-${(i + j) % CONVS}`,
        },
      ),
    ),
  );
  ids.push(...batch.map((b) => b.runId));
}
console.log(`started ${RUNS} runs in ${Date.now() - started} ms`);

// Replies for even runs, at random times (some before the run is waiting: lookback must catch those).
let published = 0;
const pending = new Set(Array.from({ length: RUNS }, (_, i) => i).filter((i) => i % 2 === 0));
const publisher = setInterval(async () => {
  for (const i of [...pending].slice(0, 100)) {
    if (Math.random() < 0.5) continue;
    pending.delete(i);
    const res = await k.publish({
      tenantId: `tenant-${(i % CONVS) % 7}`,
      key: "chaos.reply",
      scope: `run-${i}`,
      payload: { n: i },
      dedupeKey: `reply-${i}`,
    });
    if (!res.duplicate) published++;
  }
}, 100);

let kills = 0;
const killer = setInterval(() => {
  const list = [...children];
  const victim = list[Math.floor(Math.random() * list.length)];
  if (!victim) return;
  victim.kill("SIGKILL");
  kills++;
  spawnWorker();
}, KILL_EVERY_MS);

const S = `"${CHAOS_SCHEMA}"`;
for (;;) {
  const [c] = await sql.unsafe<{ open: string; done: string; failed: string }[]>(
    `select count(*) filter (where status not in ('completed','failed','cancelled')) as open,
            count(*) filter (where status = 'completed') as done,
            count(*) filter (where status = 'failed') as failed from ${S}.run`,
  );
  process.stdout.write(
    `\r${Math.round((Date.now() - started) / 1000)}s done=${c?.done} failed=${c?.failed} open=${c?.open} kills=${kills}   `,
  );
  if (Number(c?.open) === 0) break;
  if (Date.now() - started > TIMEOUT_MS) break;
  await new Promise((r) => setTimeout(r, 1000));
}
clearInterval(killer);
clearInterval(publisher);
console.log();
const elapsed = Date.now() - started;

const [runs] = await sql.unsafe<{ total: string; completed: string; failed: string; open: string }[]>(
  `select count(*) total, count(*) filter (where status='completed') completed,
     count(*) filter (where status='failed') failed,
     count(*) filter (where status not in ('completed','failed','cancelled')) open from ${S}.run`,
);
const [dups] = await sql.unsafe<{ reruns: string; steps: string }[]>(
  `select coalesce(sum(n - 1), 0) reruns, count(*) steps from (
     select run_id, step, count(*) n from chaos.effect group by 1, 2) x`,
);
const [overlap] = await sql.unsafe<{ n: string }[]>(
  `select count(*) n from chaos.effect a join chaos.effect b
     on a.conv = b.conv and a.id < b.id and a.ended_at is not null and b.ended_at is not null
    and a.started_at < b.ended_at and b.started_at < a.ended_at`,
);
const [losses] = await sql.unsafe<{ n: string }[]>(`select coalesce(sum(claim_losses),0) n from ${S}.run`);
const [wrong] = await sql.unsafe<{ n: string }[]>(
  `select count(*) n from ${S}.run where status = 'completed' and (output->>'a')::int <> (input->>'i')::int * 2`,
);

for (const c of children) c.kill("SIGTERM");
const report = {
  runs: Number(runs?.total),
  completed: Number(runs?.completed),
  failed: Number(runs?.failed),
  stuck: Number(runs?.open),
  elapsedSec: Math.round(elapsed / 1000),
  kills,
  claimLossesReaped: Number(losses?.n),
  stepExecutions: Number(dups?.steps),
  reExecutionsAfterCrash: Number(dups?.reruns),
  serialKeyOverlaps: Number(overlap?.n),
  wrongOutputs: Number(wrong?.n),
  repliesPublished: published,
};
console.log(JSON.stringify(report, null, 2));
const ok =
  report.completed === RUNS &&
  report.serialKeyOverlaps === 0 &&
  report.wrongOutputs === 0 &&
  report.reExecutionsAfterCrash <= kills * 25;
console.log(ok ? "CHAOS PASSED" : "CHAOS FAILED");
await k.close();
await sql.end();
process.exit(ok ? 0 : 1);
