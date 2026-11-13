import { Redis } from "ioredis";

/*
 * One Redis subscriber per API process, shared by every open live stream. Each organization's channel
 * is subscribed while at least one browser of that organization is listening, and dropped after the
 * last one leaves. (A connection per stream would mean a thousand Redis connections for a thousand
 * open tabs.)
 */

type Listener = (raw: string) => void;

export function createEventHub(redisUrl: string) {
  const sub = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  const listeners = new Map<string, Set<Listener>>();
  let connected: Promise<void> | null = null;

  sub.on("message", (channel: string, raw: string) => {
    for (const listener of listeners.get(channel) ?? []) {
      try {
        listener(raw);
      } catch (err) {
        console.warn("live event listener failed", err);
      }
    }
  });
  sub.on("error", (err) => console.warn("live events redis", err.message));

  return {
    /** Calls `listener` with every message on `channel`; returns a function that stops listening. */
    async listen(channel: string, listener: Listener) {
      connected ??= sub.connect();
      await connected;
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
        await sub.subscribe(channel);
      }
      set.add(listener);
      const mine = set;
      return () => {
        mine.delete(listener);
        // Commands on one connection run in order, so a later listen() re-subscribes after this.
        if (!mine.size && listeners.get(channel) === mine) {
          listeners.delete(channel);
          void sub.unsubscribe(channel).catch(() => undefined);
        }
      };
    },
    /** Open streams and channels, for health checks and tests. */
    stats: () => ({
      channels: listeners.size,
      streams: [...listeners.values()].reduce((n, s) => n + s.size, 0),
    }),
    close: () => sub.disconnect(),
  };
}

export type EventHub = ReturnType<typeof createEventHub>;
