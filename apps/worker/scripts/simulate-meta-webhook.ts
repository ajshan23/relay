/*
 * Sends a WhatsApp webhook to the local API, signed with META_APP_SECRET exactly as Meta would.
 *   pnpm --filter @relay/worker simulate <kind> [options]
 * kinds: text, image, audio, document, location, button_reply, list_reply, reaction, status:<sent|delivered|read|failed>
 * options: --text "hello"  --id wamid.custom  --our-id msg_...  --bad-signature  --twice
 */
import { signMetaPayload } from "@relay/channels";
import { env } from "@relay/core";
import { incoming, messages, status } from "../../../packages/channels/test/fixtures";

const config = env();
const args = process.argv.slice(2);
const kind = args[0] ?? "text";
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

let payload: unknown;
if (kind.startsWith("status:")) {
  const s = kind.slice("status:".length);
  payload = status({
    id: opt("id") ?? "wamid.out1",
    status: s,
    ...(opt("our-id") ? { biz_opaque_callback_data: opt("our-id") } : {}),
    ...(s === "failed" ? { errors: [{ code: 131047, title: "Re-engagement message" }] } : {}),
  });
} else if (kind === "reaction") {
  payload = incoming({
    type: "reaction",
    id: opt("id") ?? `wamid.r${Date.now()}`,
    reaction: { message_id: opt("target") ?? "wamid.out1", emoji: "👍" },
  });
} else {
  const base = messages[kind];
  if (!base) throw new Error(`Unknown kind "${kind}"`);
  const message = kind === "text" && opt("text") ? { ...base, text: { body: opt("text") } } : base;
  payload = incoming({
    ...message,
    id: opt("id") ?? `wamid.${kind}.${Date.now()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
}

const body = JSON.stringify(payload);
const secret = config.META_APP_SECRET;
if (!secret) throw new Error("Set META_APP_SECRET in .env first");
const signature = flag("bad-signature")
  ? signMetaPayload(body, "wrong-secret")
  : signMetaPayload(body, secret);
const url = `http://localhost:${config.API_PORT}/webhooks/meta`;

for (let i = 0; i < (flag("twice") ? 2 : 1); i++) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body,
  });
  console.log(`${kind}: ${res.status} ${await res.text()}`);
}
