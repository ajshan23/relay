import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createContext } from "./context";

const ctx = createContext();
const app = createApp(ctx);

const server = serve({ fetch: app.fetch, port: ctx.config.API_PORT }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

async function shutdown() {
  server.close();
  await ctx.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
