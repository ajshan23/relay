/** Small display helpers shared by the pages. */

export function ago(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const future = ms < 0;
  const s = Math.abs(ms) / 1000;
  const v =
    s < 60
      ? `${Math.round(s)}s`
      : s < 3600
        ? `${Math.round(s / 60)}m`
        : s < 86400
          ? `${Math.round(s / 3600)}h`
          : `${Math.round(s / 86400)}d`;
  return future ? `in ${v}` : `${v} ago`;
}

export function duration(from: Date | string | null, to: Date | string | null): string {
  if (!from || !to) return "—";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function when(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  if (!Number.isFinite(date.getTime())) return "never (no deadline)";
  return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });
}

export const num = (n: number | string | null | undefined) =>
  new Intl.NumberFormat("en").format(Number(n ?? 0));

export function shortId(id: string) {
  return id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-8)}` : id;
}

export function pretty(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value, null, 2);
}
