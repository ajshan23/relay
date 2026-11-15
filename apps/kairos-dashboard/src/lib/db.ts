import { createKairos, type Kairos } from "@relay/kairos";
import postgres, { type Sql } from "postgres";

/*
 * One read-mostly connection pool for the dashboard. Queries run with a statement timeout so a heavy
 * page can never hold the database. Actions (cancel, retry) go through the Kairos client.
 */
type Globals = { kairosDashSql?: Sql; kairosDashClient?: Kairos };
const g = globalThis as Globals;

export const schemaName = process.env.KAIROS_SCHEMA ?? "kairos";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName)) throw new Error("KAIROS_SCHEMA must be a plain identifier");
/** The quoted schema, safe to put in SQL. */
export const S = `"${schemaName}"`;

export function db(): Sql {
  if (!g.kairosDashSql) {
    const url = process.env.KAIROS_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error("Set KAIROS_DATABASE_URL (or DATABASE_URL) for the Kairos dashboard");
    g.kairosDashSql = postgres(url, {
      max: 4,
      onnotice: () => {},
      connection: { application_name: "kairos-dashboard", statement_timeout: 8000 },
    });
  }
  return g.kairosDashSql;
}

export function kairos(): Kairos {
  if (!g.kairosDashClient)
    g.kairosDashClient = createKairos({ sql: db(), schema: schemaName, log: () => {} });
  return g.kairosDashClient;
}

/** Runs a query; a missing schema (Kairos never migrated here) reads as empty instead of crashing. */
export async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await db().unsafe(text, params as never[])) as unknown as T[];
  } catch (err) {
    if ((err as { code?: string }).code === "3F000" || (err as { code?: string }).code === "42P01") return [];
    throw err;
  }
}
