import { createKairos, NonRetryableError } from "../src/index";

/*
 * Fills a throwaway database with a realistic mix of runs for looking at the dashboard: finished,
 * failed, sleeping, waiting with and without a deadline, retried steps, a worker that stays alive.
 * Usage: pnpm --filter @relay/kairos demo   (local test database only; never a real one)
 */
const url = process.env.KAIROS_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/kairos_test";
const k = createKairos({ databaseUrl: url, listenUrl: url, schema: "kairos", log: () => {} });
await k.sql.unsafe("drop schema if exists kairos cascade");
await k.migrate();

const automation = k.workflow(
  { name: "relay.automation", version: 2, backoff: { baseMs: 200 } },
  async (ctx, input: { conversationId: string; flow: string; name: string }) => {
    await ctx.step("send: welcome menu", () => ({ messageId: `wamid.${ctx.runId.slice(-6)}`, buttons: 3 }));
    const reply = await ctx.waitForEvent<{ text: string }>("ask: what do you need?", {
      key: "message.received",
      scope: input.conversationId,
      timeoutMs: input.flow === "slow" ? 6 * 3600_000 : 1_500,
    });
    if (reply.timedOut) {
      await ctx.step("send: are you still there?", () => ({ messageId: "wamid.nudge" }));
      return { path: "no_reply" };
    }
    await ctx.step("tag: interested", () => ({ tags: ["interested"] }));
    if (input.flow === "flaky") {
      await ctx.step("crm: create lead", ({ attempt }) => {
        if (attempt < 3) throw new Error("CRM returned 503");
        return { leadId: 42 };
      });
    }
    if (input.flow === "broken") {
      await ctx.step("send template: order_update", () => {
        throw new NonRetryableError("Template order_update is paused by Meta (quality)");
      });
    }
    if (input.flow === "followup") await ctx.sleep("wait 2 days", 2 * 86_400_000);
    await ctx.step("assign: sales team", () => ({ assignee: "Ali" }));
    return { path: "answered", text: reply.event.payload.text };
  },
);
const automationV1 = k.workflow({ name: "relay.automation", version: 1 }, async (ctx) => {
  await ctx.sleep("old flow pause", 3 * 3600_000);
});
const router = k.workflow({ name: "relay.route", version: 1 }, async (ctx, input: { event: string }) =>
  ctx.step("match triggers", () => ({ event: input.event, started: 1 })),
);

const worker = k.worker({ workflows: [automation, automationV1, router], pollMs: 100, concurrency: 30 });
await worker.start();

const flows = ["answer", "answer", "silent", "flaky", "broken", "followup", "slow", "answer"];
const tenants = ["org_lumen", "org_marina", "org_cafe"];
const runs: { id: string; conv: string; flow: string; tenant: string }[] = [];
for (let i = 0; i < 40; i++) {
  const flow = flows[i % flows.length] ?? "answer";
  const tenant = tenants[i % tenants.length] ?? "org_lumen";
  const conv = `conv_${(1000 + i).toString(36)}`;
  await k.start(
    router,
    { event: "message.received" },
    { tenantId: tenant, serialKey: conv, idempotencyKey: `evt_${i}` },
  );
  const { runId } = await k.start(
    automation,
    { conversationId: conv, flow, name: `Customer ${i}` },
    {
      tenantId: tenant,
      serialKey: conv,
      labels: { automationId: `auto_${(i % 4) + 1}`, contactId: `ct_${i}` },
    },
  );
  runs.push({ id: runId, conv, flow, tenant });
}
await k.start(automationV1, {}, { tenantId: "org_lumen", labels: { automationId: "auto_1" } });
await new Promise((r) => setTimeout(r, 800));
for (const r of runs) {
  if (r.flow === "silent" || r.flow === "slow") continue;
  await k.publish({
    tenantId: r.tenant,
    key: "message.received",
    scope: r.conv,
    payload: { text: "Price list please", from: "+9198470xxxxx", type: "text" },
  });
}
await new Promise((r) => setTimeout(r, 6000));
console.log("Demo data ready in schema kairos. The worker keeps running (Ctrl+C to stop).");
process.on("SIGINT", () => void k.close().then(() => process.exit(0)));
process.on("SIGTERM", () => void k.close().then(() => process.exit(0)));
