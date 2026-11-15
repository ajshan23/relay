import { createKairos } from "../src/index";
import { CHAOS_SCHEMA, chaosWorkflow } from "./chaos-workflow";

/** One chaos worker process. The orchestrator kills these with SIGKILL at random. */
const url = process.env.KAIROS_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/kairos_test";
const k = createKairos({
  databaseUrl: url,
  listenUrl: url,
  schema: CHAOS_SCHEMA,
  maxConnections: 6,
  log: () => {},
});
const wf = chaosWorkflow(k, url);
const w = k.worker({ workflows: [wf], concurrency: 25, tenantCap: 40, pollMs: 200, leaseMs: 3_000 });
await w.start();
process.on("SIGTERM", () => void k.close().then(() => process.exit(0)));
