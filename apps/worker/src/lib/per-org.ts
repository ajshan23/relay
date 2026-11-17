import { DelayedError, type Job } from "bullmq";
import type { Redis } from "ioredis";

/*
 * Lets each business have one job of a kind running at a time, so one business uploading 50 videos
 * (or importing 50,000 rows) takes one worker slot while other businesses' jobs use the rest. A job
 * whose business is busy is put back a few seconds later; it doesn't count as a failed attempt.
 */
export function onePerOrg<T>(
  redis: Redis,
  kind: string,
  orgOf: (job: Job<T>) => Promise<string | null> | string | null,
  run: (job: Job<T>) => Promise<unknown>,
  opts: { holdMs?: number; retryMs?: number } = {},
) {
  const holdMs = opts.holdMs ?? 10 * 60_000;
  const retryMs = opts.retryMs ?? 3_000;
  return async (job: Job<T>, token?: string) => {
    const org = await orgOf(job);
    if (!org) return run(job);
    const key = `lock:${kind}:${org}`;
    const mine = `${job.id ?? "job"}:${Date.now()}`;
    const got = await redis.set(key, mine, "PX", holdMs, "NX");
    if (!got) {
      await job.moveToDelayed(Date.now() + retryMs, token);
      throw new DelayedError();
    }
    try {
      return await run(job);
    } finally {
      // Only release our own lock (it may have expired and been taken by another job).
      if ((await redis.get(key)) === mine) await redis.del(key);
    }
  };
}
