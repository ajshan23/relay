import { createHash, randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";

/** Anything that can run a parameterised statement: Kairos's own pool, a transaction, or the caller's. */
export type Executor = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export function fromPostgres(sql: Sql | TransactionSql): Executor {
  return {
    query: async <T>(text: string, params: unknown[] = []) =>
      (await sql.unsafe(text, params as never[])) as unknown as T[],
  };
}

/** A schema name is put straight into SQL, so only plain identifiers are allowed. */
export function quoteSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
    throw new Error(`Kairos schema must be a lowercase identifier, got "${schema}"`);
  return `"${schema}"`;
}

/** JSON for a jsonb parameter. `undefined` becomes null. */
export function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** What a value looks like after being stored and read back, so a first run and a replay see the same. */
export function roundTrip<T>(value: T): T {
  if (value === undefined) return null as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Sortable unique id: 12 hex chars of milliseconds + 16 random hex chars, with a prefix. */
export function newId(prefix: string): string {
  const time = Date.now().toString(16).padStart(12, "0");
  return `${prefix}_${time}${randomBytes(8).toString("hex")}`;
}

export function hash(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}

/** A 64-bit key for pg_advisory_xact_lock (pass with `::bigint`), from any text. */
export function lockKey(text: string): string {
  return createHash("sha1").update(text).digest().readBigInt64BE(0).toString();
}

/** A cancelled run's final state. The wakeup row must already be gone. */
export async function finalizeCancelled(ex: Executor, S: string, runId: string) {
  await ex.query(
    `update ${S}.run set status = 'cancelled', finished_at = now(), updated_at = now() where id = $1`,
    [runId],
  );
  await ex.query(
    `update ${S}.wait set status = 'cancelled', resolved_at = now() where run_id = $1 and status = 'open'`,
    [runId],
  );
}
