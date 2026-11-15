# Credits

Kairos is written from scratch. No code was copied, but its design borrows ideas from these open-source projects, with thanks:

- **Hatchet** (MIT, Hatchet Technologies Inc.). Replaying durable tasks from a step log, with a hash per entry to detect code that no longer matches. Timers and event waits share one wake path. Waits look back over recent events for their scope. Claims are reaped from workers that stop heartbeating. Busy tables get their own autovacuum settings.
- **DBOS Transact** (MIT, DBOS Inc.). Checkpointing each step by run and position. Runs are pinned to a workflow version, and old versions drain on old code. One run at a time per partition key.
- **pg-boss** (MIT, Tim Jones). The attempt fence: a stale worker's writes are rejected. Each key's head runs alone (strict FIFO per key). NOTIFY is only a hint, and polling is what the system relies on.
- **graphile-worker** (MIT, Benjie Gillam). One job per named queue per claim, and stale locks are reset.
- **River** (MPL-2.0). Ideas only: claiming in a single statement with `FOR UPDATE SKIP LOCKED` and returning the claimed rows, and waking listeners with a short cooldown.
