import { defineConfig } from "drizzle-kit";

/*
 * Migrations run over a session connection, not a transaction-mode pooler (fine for the app, not for
 * schema changes): Supabase's transaction port 6543 becomes its session port 5432 on the same host,
 * and Neon's "-pooler" host its direct one. MIGRATE_DATABASE_URL overrides all of that.
 */
const url =
  process.env.MIGRATE_DATABASE_URL ??
  (process.env.DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay")
    .replace("-pooler.", ".")
    .replace(/:6543(\/|$)/, ":5432$1");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
});
