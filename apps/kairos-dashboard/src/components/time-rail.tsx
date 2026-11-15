import { cn } from "@/lib/utils";

/*
 * The time rail: the last 12 hours and the next 12 around a "now" line. Left of now, runs that
 * finished in each half hour (failed on top, in red); right of now, runs due to wake in each half
 * hour (hatched, because they haven't happened yet). What Kairos does, in one picture.
 */

export type RailData = {
  /** 24 half hours, index 0 = the most recent. */
  past: { completed: number; failed: number }[];
  /** 24 half hours, index 0 = the next one. */
  future: number[];
  readyNow: number;
};

const H = 150;
/** Square-root scale: a busy half hour doesn't flatten every quiet one into nothing. */
const h = (n: number, max: number) => (n ? Math.max(3, Math.sqrt(n / max) * H) : 0);

export function TimeRail({ data }: { data: RailData }) {
  const max = Math.max(1, ...data.past.map((p) => p.completed + p.failed), ...data.future);
  const finished = data.past.reduce((n, p) => n + p.completed + p.failed, 0);
  const failed = data.past.reduce((n, p) => n + p.failed, 0);
  const waking = data.future.reduce((n, x) => n + x, 0);
  const label = `Last 12 hours: ${finished} runs finished, ${failed} failed. Next 12 hours: ${waking} runs due to wake. ${data.readyNow} ready right now.`;

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-elevated">
      <div className="flex flex-wrap items-end justify-between gap-6 px-6 pt-5">
        <div>
          <p className="text-[13px] text-muted-foreground">Finished in the last 12 hours</p>
          <p className="mt-1 text-[34px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
            {finished.toLocaleString()}
            {failed ? (
              <span className="ml-2 align-middle text-sm font-medium tracking-normal text-destructive">
                {failed.toLocaleString()} failed
              </span>
            ) : null}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[13px] text-muted-foreground">Due to wake in the next 12 hours</p>
          <p className="mt-1 text-[34px] leading-none font-semibold tracking-[-0.03em] text-primary tabular-nums">
            {waking.toLocaleString()}
          </p>
        </div>
      </div>

      <div className="relative px-6 pt-8 pb-3" role="img" aria-label={label}>
        <div className="flex items-end gap-[3px]" style={{ height: H }}>
          {[...data.past].reverse().map((p, i) => {
            const total = p.completed + p.failed;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed half-hour slots
                key={`p${i}`}
                className="flex flex-1 flex-col justify-end"
                title={`${23 - i === 0 ? "Last half hour" : `${(24 - i) / 2} h ago`}: ${p.completed} completed, ${p.failed} failed`}
              >
                {p.failed ? (
                  <div
                    className="rounded-t-[3px] bg-destructive"
                    style={{ height: `${h(p.failed, max)}px` }}
                  />
                ) : null}
                <div
                  className={cn("bg-rail-past", !p.failed && "rounded-t-[3px]")}
                  style={{
                    height: p.completed
                      ? `${Math.max(2, h(total, max) - h(p.failed, max))}px`
                      : total
                        ? "0px"
                        : "2px",
                    opacity: total ? 1 : 0.35,
                  }}
                />
              </div>
            );
          })}

          {/* now */}
          <div className="relative mx-2 w-[2px] self-stretch">
            <div className="absolute inset-0 rounded-full bg-now shadow-[0_0_14px_var(--now)]" />
            <div className="absolute -top-6 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-now px-2 py-0.5 text-[11px] font-semibold text-background">
              <span className="kairos-breathe size-1.5 rounded-full bg-background" aria-hidden />
              now{data.readyNow ? `, ${data.readyNow} ready` : ""}
            </div>
          </div>

          {data.future.map((n, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed half-hour slots
              key={`f${i}`}
              className="flex flex-1 flex-col justify-end"
              title={`In ${(i + 1) / 2} h: ${n} due to wake`}
            >
              <div
                className="rounded-t-[3px] border border-b-0 border-rail-future/70"
                style={{
                  height: n ? `${h(n, max)}px` : "2px",
                  opacity: n ? 1 : 0.35,
                  backgroundImage:
                    "repeating-linear-gradient(135deg, color-mix(in oklab, var(--rail-future) 38%, transparent) 0 3px, transparent 3px 6px)",
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex text-[11px] text-muted-foreground">
          <span className="flex-1">12 h ago</span>
          <span className="flex-1 text-center">6 h ago</span>
          <span className="w-16 text-center font-medium text-now">now</span>
          <span className="flex-1 text-center">in 6 h</span>
          <span className="flex-1 text-right">in 12 h</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-5 border-t px-6 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-[3px] bg-rail-past" aria-hidden />
          Completed
        </span>
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-[3px] bg-destructive" aria-hidden />
          Failed
        </span>
        <span className="flex items-center gap-2">
          <span
            className="size-2.5 rounded-[3px] border border-rail-future/70"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, color-mix(in oklab, var(--rail-future) 45%, transparent) 0 2px, transparent 2px 4px)",
            }}
            aria-hidden
          />
          Sleeping or waiting, due then
        </span>
      </div>
    </section>
  );
}
