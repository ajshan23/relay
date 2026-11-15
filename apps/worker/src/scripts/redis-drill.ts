import { execSync } from "node:child_process";
import { signMetaPayload } from "@relay/channels";
import { createDb } from "@relay/db";

/*
 * Redis outage drill against an isolated stack (drill DB + throwaway Redis container, API :3291,
 * worker :3292). Never touches the real dev database or the normal local Redis.
 */
process.loadEnvFile(new URL("../../../../.env", import.meta.url).pathname);
const secret = process.env.META_APP_SECRET ?? "";
const API = "http://127.0.0.1:3291";
const { sql: db } = createDb("postgres://relay:relay@localhost:5544/relay_drill");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timed(label: string, fn: () => Promise<Response>) {
  const t = Date.now();
  try {
    const r = await fn();
    const body = (await r.text()).slice(0, 120);
    console.log(`${label}: ${r.status} in ${Date.now() - t} ms ${body}`);
  } catch (e) {
    console.log(`${label}: ERROR after ${Date.now() - t} ms ${(e as Error).message}`);
  }
}

function webhook(i: number) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "drill-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "999000111", display_phone_number: "000" },
              statuses: [
                {
                  id: `wamid.drill.${Date.now()}.${i}`,
                  status: "delivered",
                  timestamp: `${Math.floor(Date.now() / 1000)}`,
                  recipient_id: "100",
                },
              ],
            },
          },
        ],
      },
    ],
  });
  return fetch(`${API}/webhooks/meta`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(body, secret) },
    body,
    signal: AbortSignal.timeout(15_000),
  });
}

await db`delete from webhook_event where object = 'whatsapp_business_account'`;
await timed("ready (redis up)", () => fetch(`${API}/health/ready`));
await timed("webhook (redis up)", () => webhook(0));
await sleep(2000);

console.log("\n--- stopping Redis ---");
execSync("docker stop relay-drill-redis", { stdio: "ignore" });
const down = Date.now();
await timed("ready (redis down)", () => fetch(`${API}/health/ready`));
for (let i = 1; i <= 3; i++) await timed(`webhook ${i} (redis down)`, () => webhook(i));
await timed("worker health (redis down)", () =>
  fetch("http://127.0.0.1:3292", { signal: AbortSignal.timeout(5000) }),
);
const [pending] = await db`select count(*)::int n from webhook_event where processed_at is null`;
console.log(`stored but unprocessed while Redis is down: ${pending?.n}`);

await sleep(Math.max(0, 30_000 - (Date.now() - down)));
console.log("\n--- starting Redis again (it was down 30 s) ---");
execSync("docker start relay-drill-redis", { stdio: "ignore" });
const up = Date.now();
for (;;) {
  const [r] =
    await db`select count(*) filter (where processed_at is null)::int open, count(*)::int total from webhook_event`;
  if (r && r.open === 0) {
    console.log(
      `all ${r.total} webhook events processed ${Math.round((Date.now() - up) / 1000)} s after Redis came back`,
    );
    break;
  }
  if (Date.now() - up > 150_000) {
    console.log(`STILL UNPROCESSED after 150 s: ${r?.open}`);
    break;
  }
  await sleep(2000);
}
const [dups] =
  await db`select count(*)::int n from (select dedupe_key from webhook_event group by 1 having count(*) > 1) x`;
console.log(`duplicate stored events: ${dups?.n}`);
await timed("ready (redis back)", () => fetch(`${API}/health/ready`));
await db.end();
