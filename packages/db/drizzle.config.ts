import { defineConfig } from "drizzle-kit";

/*
 * Migrations run over a direct connection. Neon's pooled address ("-pooler" in the host) runs in
 * transaction mode, which suits the app but not schema changes, so the pooler part is dropped here.
 */
const url = (process.env.DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay").replace(
  "-pooler.",
  ".",
);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
});
