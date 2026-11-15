import type { Queue } from "bullmq";

/*
 * Adds a job without ever holding up the request. If Redis is slow or away, the add keeps waiting in
 * the background (BullMQ's connection queues it until Redis is back) and the request carries on after
 * a second. Work that must not be lost has a Postgres sweeper behind it in the worker: webhook events
 * still unprocessed and outgoing messages still queued are put back on their queues every minute.
 * Returns whether the job was confirmed in time.
 */
export async function enqueue<T>(
  queue: Queue<T>,
  name: string,
  data: T,
  opts?: Parameters<Queue<T>["add"]>[2],
  waitMs = 1000,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const add = (queue.add as (n: string, d: T, o?: unknown) => Promise<unknown>)(name, data, opts);
  try {
    await Promise.race([
      add,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), waitMs);
      }),
    ]);
    return true;
  } catch (err) {
    console.warn(
      `queue ${queue.name}: "${name}" not confirmed (${(err as Error).message}); it will catch up`,
    );
    add.catch(() => {});
    return false;
  } finally {
    clearTimeout(timer);
  }
}
