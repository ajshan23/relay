import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isKairosControl, type Kairos, NonRetryableError, StepFailedError } from "../src/index";
import { fast, setup, sleep, teardown, waitFor } from "./helpers";

let k: Kairos;
before(async () => {
  k = await setup();
});
after(async () => {
  await teardown(k);
});

describe("migrations", () => {
  it("can run again and from several processes at once", async () => {
    const results = await Promise.all([k.migrate(), k.migrate(), k.migrate()]);
    assert.deepEqual(
      results.map((r) => r.applied.length),
      [0, 0, 0],
    );
  });
});

describe("runs and steps", () => {
  it("runs a workflow to completion and records each step once", async () => {
    const calls: string[] = [];
    const wf = k.workflow({ name: "basic", version: 1 }, async (ctx, input: { n: number }) => {
      const a = await ctx.step("double", () => {
        calls.push("double");
        return input.n * 2;
      });
      await ctx.sleep("nap", 100);
      const b = await ctx.step("add", () => {
        calls.push("add");
        return a + 1;
      });
      return { b };
    });
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, { n: 5 }, { tenantId: "t1" });
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.status, "completed");
    assert.deepEqual(r.run.output, { b: 11 });
    // The sleep made the run replay from the top: "double" must not run twice.
    assert.deepEqual(calls, ["double", "add"]);
    assert.deepEqual(
      r.steps.map((s) => [s.kind, s.name, s.status]),
      [
        ["step", "double", "completed"],
        ["sleep", "nap", "completed"],
        ["step", "add", "completed"],
      ],
    );
    assert.equal(r.wakeup, null);
  });

  it("finds runs by label", async () => {
    const wf = k.workflow({ name: "labelled", version: 1 }, async () => 1);
    const a = await k.start(wf, {}, { tenantId: "t9", labels: { automationId: "aut_1", contactId: "c1" } });
    await k.start(wf, {}, { tenantId: "t9", labels: { automationId: "aut_2", contactId: "c1" } });
    const found = await k.listRuns({ labels: { automationId: "aut_1" } });
    assert.deepEqual(
      found.map((r) => r.id),
      [a.runId],
    );
    assert.equal((await k.listRuns({ labels: { contactId: "c1" }, tenantId: "t9" })).length, 2);
  });

  it("returns the existing run for a repeated idempotency key", async () => {
    const wf = k.workflow({ name: "idem", version: 1 }, async () => 1);
    const a = await k.start(wf, {}, { tenantId: "t1", idempotencyKey: "same" });
    const b = await k.start(wf, {}, { tenantId: "t1", idempotencyKey: "same" });
    const c = await k.start(wf, {}, { tenantId: "t2", idempotencyKey: "same" });
    assert.equal(a.runId, b.runId);
    assert.equal(b.created, false);
    assert.notEqual(a.runId, c.runId);
    await k.cancel(a.runId);
    await k.cancel(c.runId);
  });

  it("retries a failing step with backoff and keeps the same idempotency key", async () => {
    const keys: string[] = [];
    const wf = k.workflow(
      { name: "retry", version: 1, backoff: { baseMs: 20, factor: 1, maxMs: 20 } },
      async (ctx) =>
        ctx.step("flaky", ({ attempt, idempotencyKey }) => {
          keys.push(idempotencyKey);
          if (attempt < 3) throw new Error(`boom ${attempt}`);
          return attempt;
        }),
    );
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.output, 3);
    assert.equal(new Set(keys).size, 1);
    assert.equal(keys.length, 3);
    assert.equal(r.steps[0]?.attempt, 3);
  });

  it("gives up after the retries and lets the handler take another path", async () => {
    let tries = 0;
    const wf = k.workflow(
      { name: "giveup", version: 1, retries: 1, backoff: { baseMs: 10 } },
      async (ctx) => {
        try {
          await ctx.step("always fails", () => {
            tries++;
            throw new Error("nope");
          });
          return "impossible";
        } catch (e) {
          if (isKairosControl(e)) throw e;
          assert.ok(e instanceof StepFailedError);
          return ctx.step("fallback", () => "fallback");
        }
      },
    );
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.output, "fallback");
    assert.equal(tries, 2);
  });

  it("fails at once on a NonRetryableError and records the error", async () => {
    let tries = 0;
    const wf = k.workflow({ name: "fatal", version: 1 }, async (ctx) => {
      await ctx.step("bad input", () => {
        tries++;
        throw new NonRetryableError("bad input");
      });
    });
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.status, "failed");
    assert.equal(tries, 1);
    assert.match(JSON.stringify(r.run.error), /bad input/);
  });

  it("times out a step that hangs", async () => {
    const wf = k.workflow({ name: "slow", version: 1, retries: 0, stepTimeoutMs: 100 }, async (ctx) =>
      ctx.step("hang", () => new Promise(() => {})),
    );
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.status, "failed");
    assert.match(JSON.stringify(r.run.error), /timed out/);
  });
});

describe("events and waits", () => {
  it("resumes a waiting run when its event is published, and times out otherwise", async () => {
    const wf = k.workflow(
      { name: "ask", version: 1 },
      async (ctx, input: { conv: string; timeoutMs: number }) => {
        const r = await ctx.waitForEvent<{ text: string }>("reply", {
          key: "message.received",
          scope: input.conv,
          timeoutMs: input.timeoutMs,
        });
        return r.timedOut ? "no reply" : r.event.payload.text;
      },
    );
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const answered = await k.start(wf, { conv: "c1", timeoutMs: 60_000 }, { tenantId: "t1" });
    const silent = await k.start(wf, { conv: "c2", timeoutMs: 300 }, { tenantId: "t1" });
    await waitFor(k, answered.runId, ["waiting"]);
    const pub = await k.publish({
      tenantId: "t1",
      key: "message.received",
      scope: "c1",
      payload: { text: "yes" },
    });
    assert.deepEqual(pub.matchedRuns, [answered.runId]);
    const a = await waitFor(k, answered.runId, ["completed", "failed"]);
    const s = await waitFor(k, silent.runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(a.run.output, "yes");
    assert.equal(s.run.output, "no reply");
    assert.equal(a.waits[0]?.status, "matched");
    assert.equal(s.waits[0]?.status, "timed_out");
  });

  it("catches an event published after the previous step but before the wait (lookback)", async () => {
    const wf = k.workflow({ name: "race", version: 1 }, async (ctx) => {
      await ctx.step("send question", async () => {
        // The customer answers before the run gets to its wait.
        await k.publish({ tenantId: "t1", key: "message.received", scope: "c3", payload: { text: "fast" } });
      });
      const r = await ctx.waitForEvent<{ text: string }>("answer", {
        key: "message.received",
        scope: "c3",
        timeoutMs: 5_000,
      });
      return r.timedOut ? "lost" : r.event.payload.text;
    });
    // An older event for the same scope must not count.
    await k.publish({ tenantId: "t1", key: "message.received", scope: "c3", payload: { text: "old" } });
    await sleep(20);
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.output, "fast");
  });

  it("matches only events whose payload contains the filter, and ignores duplicates", async () => {
    const wf = k.workflow({ name: "filter", version: 1 }, async (ctx) => {
      const r = await ctx.waitForEvent<{ kind: string }>("button", {
        key: "message.received",
        scope: "c4",
        filter: { kind: "button" },
        timeoutMs: 5_000,
      });
      return r.timedOut ? null : r.event.payload.kind;
    });
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    await waitFor(k, runId, ["waiting"]);
    const text = await k.publish({
      tenantId: "t1",
      key: "message.received",
      scope: "c4",
      payload: { kind: "text" },
    });
    assert.deepEqual(text.matchedRuns, []);
    const btn = {
      tenantId: "t1",
      key: "message.received",
      scope: "c4",
      payload: { kind: "button" },
      dedupeKey: "m1",
    };
    assert.equal((await k.publish(btn)).matchedRuns.length, 1);
    assert.equal((await k.publish(btn)).duplicate, true);
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.output, "button");
  });
});

describe("control", () => {
  it("cancels a waiting run at once and a running one at its next step", async () => {
    let reachedSecond = false;
    const wf = k.workflow({ name: "cancel", version: 1 }, async (ctx, input: { mode: string }) => {
      if (input.mode === "wait") await ctx.waitForEvent("w", { key: "never" });
      await ctx.step("first", () => sleep(300));
      await ctx.step("second", () => {
        reachedSecond = true;
      });
    });
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const waiting = await k.start(wf, { mode: "wait" }, { tenantId: "t1" });
    const busy = await k.start(wf, { mode: "run" }, { tenantId: "t1" });
    await waitFor(k, waiting.runId, ["waiting"]);
    await waitFor(k, busy.runId, ["running"]);
    assert.equal(await k.cancel(waiting.runId), true);
    assert.equal((await k.getRun(waiting.runId))?.run.status, "cancelled");
    await k.cancel(busy.runId);
    await waitFor(k, busy.runId, ["cancelled"]);
    await sleep(100);
    await w.stop();
    assert.equal(reachedSecond, false);
    assert.equal((await k.getRun(waiting.runId))?.waits[0]?.status, "cancelled");
  });

  it("never runs two runs with the same serial key at once", async () => {
    let inside = 0;
    let maxInside = 0;
    const wf = k.workflow({ name: "serial", version: 1 }, async (ctx) => {
      await ctx.step("critical", async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(30);
        inside--;
      });
    });
    const w1 = k.worker({ workflows: [wf], ...fast });
    const w2 = k.worker({ workflows: [wf], ...fast });
    await Promise.all([w1.start(), w2.start()]);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => k.start(wf, {}, { tenantId: "t1", serialKey: "conv-1" })),
    );
    for (const { runId } of ids) await waitFor(k, runId, ["completed"]);
    await Promise.all([w1.stop(), w2.stop()]);
    assert.equal(maxInside, 1);
  });

  it("shares workers fairly: a busy tenant can't starve a small one", async () => {
    const finished: string[] = [];
    const wf = k.workflow({ name: "fair", version: 1 }, async (ctx, input: { t: string }) => {
      await ctx.step("work", () => sleep(40));
      finished.push(input.t);
    });
    // Big tenant enqueues first.
    const big = await Promise.all(
      Array.from({ length: 30 }, () => k.start(wf, { t: "big" }, { tenantId: "big" })),
    );
    const small = await Promise.all(
      Array.from({ length: 3 }, () => k.start(wf, { t: "small" }, { tenantId: "small" })),
    );
    const w = k.worker({ workflows: [wf], pollMs: 50, concurrency: 4, tenantCap: 2 });
    await w.start();
    for (const { runId } of [...big, ...small]) await waitFor(k, runId, ["completed"], 20_000);
    await w.stop();
    const lastSmall = finished.lastIndexOf("small");
    assert.ok(lastSmall < 12, `small tenant finished at position ${lastSmall} of ${finished.length}`);
  });

  it("only claims versions this worker knows, so old runs finish on old code", async () => {
    const v1 = k.workflow({ name: "ver", version: 1 }, async () => "v1");
    const v2 = k.workflow({ name: "ver", version: 2 }, async () => "v2");
    const old = await k.start(v1, {}, { tenantId: "t1" });
    const w2 = k.worker({ workflows: [v2], ...fast });
    await w2.start();
    const fresh = await k.start(v2, {}, { tenantId: "t1" });
    assert.equal((await waitFor(k, fresh.runId, ["completed"])).run.output, "v2");
    await sleep(200);
    assert.equal((await k.getRun(old.runId))?.run.status, "queued");
    const w1 = k.worker({ workflows: [v1], ...fast });
    await w1.start();
    assert.equal((await waitFor(k, old.runId, ["completed"])).run.output, "v1");
    await Promise.all([w1.stop(), w2.stop()]);
  });

  it("fails a run whose code no longer matches its recorded steps", async () => {
    let flip = false;
    const wf = k.workflow({ name: "drift", version: 1 }, async (ctx) => {
      await ctx.step(flip ? "renamed" : "original", () => 1);
      await ctx.sleep("pause", 150);
      flip = true;
      await ctx.step("after", () => 2);
    });
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    // First claim: records "original", sleeps; meanwhile "flip" turns on as the code "changes".
    await waitFor(k, runId, ["sleeping"]);
    flip = true;
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.status, "failed");
    assert.match(JSON.stringify(r.run.error), /NonDeterminismError|recorded as step/);
  });

  it("retries a failed run from the failed step, keeping earlier results", async () => {
    let firstCalls = 0;
    let broken = true;
    const wf = k.workflow({ name: "fixme", version: 1, retries: 0 }, async (ctx) => {
      await ctx.step("first", () => {
        firstCalls++;
      });
      return ctx.step("second", () => {
        if (broken) throw new Error("bug");
        return "fixed";
      });
    });
    const w = k.worker({ workflows: [wf], ...fast });
    await w.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    await waitFor(k, runId, ["failed"]);
    broken = false;
    await k.retry(runId);
    const r = await waitFor(k, runId, ["completed", "failed"]);
    await w.stop();
    assert.equal(r.run.output, "fixed");
    assert.equal(firstCalls, 1);
  });
});

describe("crashes", () => {
  it("gives a run to another worker when its worker stops heartbeating, and the old one can't write", async () => {
    let executions = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const wf = k.workflow({ name: "crash", version: 1, stepTimeoutMs: 30_000 }, async (ctx) => {
      return ctx.step("side effect", async () => {
        executions++;
        if (executions === 1) await gate; // the first worker "hangs" here
        return executions;
      });
    });
    // Worker A: short lease, no heartbeat in time (heartbeats run every 10 s).
    const a = k.worker({
      workflows: [wf],
      pollMs: 50,
      leaseMs: 300,
      noMaintenance: true,
      shutdownGraceMs: 0,
    });
    await a.start();
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    await waitFor(k, runId, ["running"]);
    await a.stop(); // stops claiming; its hung step is still in flight
    const b = k.worker({ workflows: [wf], pollMs: 50 });
    await b.start();
    const r = await waitFor(k, runId, ["completed", "failed"], 15_000);
    release(); // A's step finishes late: its write must be rejected
    await sleep(200);
    await b.stop();
    assert.equal(r.run.status, "completed");
    assert.equal(r.run.output, 2);
    const again = await k.getRun(runId);
    assert.equal(again?.run.output, 2);
    assert.equal(again?.steps.length, 1);
  });

  it("reaps a claim whose worker died, and fails a run that keeps killing its worker", async () => {
    const wf = k.workflow({ name: "orphan", version: 1 }, async (ctx) => ctx.step("work", () => "done"));
    const { runId } = await k.start(wf, {}, { tenantId: "t1" });
    const S = `"${k.schema}"`;
    // A worker that crashed: holds the claim, never heartbeats.
    await k.sql.unsafe(
      `update ${S}.wakeup set claimed_by = 'dead', claimed_until = now() - interval '1 second', attempt = attempt + 1 where run_id = $1`,
      [runId],
    );
    const poison = await k.start(wf, {}, { tenantId: "t1" });
    await k.sql.unsafe(
      `update ${S}.wakeup set claimed_by = 'dead', claimed_until = now() - interval '1 second' where run_id = $1`,
      [poison.runId],
    );
    await k.sql.unsafe(`update ${S}.run set claim_losses = 4 where id = $1`, [poison.runId]);
    const b = k.worker({ workflows: [wf], pollMs: 50 });
    await b.start();
    const r = await waitFor(k, runId, ["completed", "failed"], 15_000);
    const p = await waitFor(k, poison.runId, ["completed", "failed"], 15_000);
    await b.stop();
    assert.equal(r.run.status, "completed");
    assert.equal(r.run.claim_losses, 1);
    assert.equal(p.run.status, "failed");
    assert.match(JSON.stringify(p.run.error), /ClaimLost/);
  });
});
