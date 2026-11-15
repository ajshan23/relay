import { randomBytes } from "node:crypto";
import { createKairos, type Kairos } from "../src/index";

/**
 * Tests run against a throwaway database (never Relay's data): the local Docker Postgres by default.
 * Each test file gets its own schema, dropped afterwards.
 */
export const TEST_URL =
  process.env.KAIROS_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/kairos_test";

export async function setup(): Promise<Kairos> {
  const schema = `kt_${randomBytes(4).toString("hex")}`;
  const kairos = createKairos({ databaseUrl: TEST_URL, schema, listenUrl: TEST_URL, log: () => {} });
  await kairos.migrate();
  return kairos;
}

export async function teardown(kairos: Kairos) {
  await kairos.sql.unsafe(`drop schema if exists "${kairos.schema}" cascade`);
  await kairos.close();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until the run reaches one of the statuses. */
export async function waitFor(kairos: Kairos, runId: string, statuses: string[], timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await kairos.getRun(runId);
    if (r && statuses.includes(r.run.status)) return r;
    if (Date.now() > until)
      throw new Error(`run ${runId} stayed ${r?.run.status}, wanted ${statuses.join("|")}`);
    await sleep(25);
  }
}

export const fast = { pollMs: 50, concurrency: 20 };
