/*
 * pm2 processes for running Relay on a server: pm2 start ecosystem.config.cjs
 * Everything listens on 127.0.0.1; nginx is the only way in (see docs/deploy.md).
 * Settings come from the .env at the repo root. Memory limits restart a process before it can
 * starve the other apps on the same machine.
 */
const env = { NODE_ENV: "production", HOST: "127.0.0.1" };
const ts = ["--env-file=../../.env", "--import", "tsx"];
// pm2 6 runs .ts files with Bun unless told otherwise; Relay runs on Node (through tsx).
const interpreter = "node";

module.exports = {
  apps: [
    {
      name: "relay-web",
      cwd: "apps/web",
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3200 --hostname 127.0.0.1",
      env,
      max_memory_restart: "450M",
    },
    {
      name: "relay-api",
      cwd: "apps/api",
      script: "src/index.ts",
      interpreter,
      node_args: ts,
      env,
      max_memory_restart: "400M",
      kill_timeout: 10000,
    },
    {
      name: "relay-realtime",
      cwd: "apps/api",
      script: "src/realtime.ts",
      interpreter,
      node_args: ts,
      env,
      max_memory_restart: "200M",
    },
    {
      name: "relay-worker",
      cwd: "apps/worker",
      script: "src/index.ts",
      interpreter,
      node_args: ts,
      env,
      max_memory_restart: "450M",
      // Let in-flight sends finish before a restart.
      kill_timeout: 30000,
    },
  ],
};
