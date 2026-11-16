import type { Db } from "./client";

/*
 * Lets libraries that take a plain `{ query(text, params) }` (Kairos) run inside a Drizzle transaction,
 * so their rows commit or roll back together with ours. Drizzle's postgres-js transaction keeps the
 * postgres.js transaction client on `session.client`; outside a transaction the pool is `$client`.
 */

type Unsafe = { unsafe: (text: string, params: unknown[]) => Promise<unknown[]> };
// biome-ignore lint/suspicious/noExplicitAny: a Drizzle transaction or database of any schema
export type DbOrTx = Db | any;

export function sqlExecutor(dbOrTx: DbOrTx) {
  const client =
    (dbOrTx as { session?: { client?: Unsafe } }).session?.client ?? (dbOrTx as { $client?: Unsafe }).$client;
  if (!client?.unsafe) throw new Error("sqlExecutor needs a postgres-js Drizzle database or transaction");
  return {
    query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
      (await client.unsafe(text, params)) as T[],
  };
}
