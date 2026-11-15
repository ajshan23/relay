import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Inside the Relay monorepo the settings live in the root .env (KAIROS_DATABASE_URL or DATABASE_URL,
// KAIROS_ADMIN_PASSWORD). Values already set in the environment win.
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {}
}

const nextConfig: NextConfig = {
  transpilePackages: ["@relay/kairos"],
  serverExternalPackages: ["postgres"],
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
