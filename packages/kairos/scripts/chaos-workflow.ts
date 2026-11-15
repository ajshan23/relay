import postgres from "postgres";
import type { Kairos } from "../src/index";

/*
 * The chaos test's workflow. Each step records when it ran in chaos.effect, so the orchestrator can
 * count re-executions and find overlapping runs of one serial key.
 */
export const CHAOS_SCHEMA = "kairos_chaos";

export function chaosWorkflow(k: Kairos, url: string) {
  const fx = postgres(url, { max: 4, onnotice: () => {} });
  const record = async (runId: string, step: string, conv: string, body: () => Promise<void>) => {
    const [row] = await fx`insert into chaos.effect (run_id, step, conv, pid, started_at)
      values (${runId}, ${step}, ${conv}, ${process.pid}, clock_timestamp()) returning id`;
    await body();
    await fx`update chaos.effect set ended_at = clock_timestamp() where id = ${row?.id}`;
  };
  return k.workflow(
    { name: "chaos", version: 1, stepTimeoutMs: 10_000, backoff: { baseMs: 100 } },
    async (ctx, input: { i: number; conv: string }) => {
      const a = await ctx.step("a", () =>
        record(
          ctx.runId,
          "a",
          input.conv,
          () => new Promise((r) => setTimeout(r, 20 + (input.i % 7) * 10)),
        ).then(() => input.i * 2),
      );
      await ctx.sleep("pause", 100 + (input.i % 5) * 150);
      const reply = await ctx.waitForEvent<{ n: number }>("reply", {
        key: "chaos.reply",
        scope: `run-${input.i}`,
        timeoutMs: 1_500,
      });
      const b = await ctx.step("b", () =>
        record(ctx.runId, "b", input.conv, () => new Promise((r) => setTimeout(r, 15))).then(() =>
          reply.timedOut ? -1 : reply.event.payload.n,
        ),
      );
      if (input.i % 50 === 0) {
        // A flaky step: fails twice, then works.
        await ctx.step("flaky", ({ attempt }) => {
          if (attempt < 3) throw new Error("flaky");
          return attempt;
        });
      }
      return { a, b };
    },
  );
}
