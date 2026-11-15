import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

export type Db = ReturnType<typeof createDb>["db"];

/**
 * Whether a URL goes through a transaction-mode pooler (Supabase's port 6543, or a "pgbouncer=true"
 * URL), where one session's prepared statements can land on another connection: those are turned off.
 */
export function isTransactionPooler(url: string): boolean {
  return /:6543(\/|$)/.test(url) || /[?&]pgbouncer=true/.test(url);
}

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, prepare: !isTransactionPooler(url) });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
