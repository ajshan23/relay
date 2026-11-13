/*
 * Sends a WhatsApp webhook to the local API, signed with META_APP_SECRET exactly as Meta would.
 *   pnpm --filter @relay/worker simulate <kind> [options]
 * kinds: text, image, audio, document, location, button_reply, list_reply, reaction, status:<sent|delivered|read|failed>
 *        group:text, group:status:<sent|delivered|read|failed>, group:created, group:failed, group:join, group:leave,
 *        group:removed, group:join-request, group:join-withdrawn, group:subject, group:suspend, group:restore, group:delete
 * options: --text "hello"  --id wamid.custom  --our-id msg_...  --bad-signature  --twice
 *          --group <group id>  --request-id <id>  --person <BSUID>  --phone <digits>  --name "Name"  --subject "Text"
 */
import { signMetaPayload } from "@relay/channels";
import { env } from "@relay/core";
import { envelope, incoming, messages, status } from "../../../packages/channels/test/fixtures";

const config = env();
const args = process.argv.slice(2);
const kind = args[0] ?? "text";
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

let payload: unknown;
const group = opt("group") ?? "120363000000000001";
const person = { user_id: opt("person") ?? "US.1349000000000002", wa_id: opt("phone") ?? "15550003333" };
const groupHook = (field: string, g: Record<string, unknown>) =>
  envelope({ groups: [{ timestamp: String(Math.floor(Date.now() / 1000)), group_id: group, ...g }] }, field);

if (kind === "group:text") {
  payload = envelope({
    contacts: [{ profile: { name: opt("name") ?? "Omar Test" }, ...person }],
    messages: [
      {
        from: person.wa_id,
        from_user_id: person.user_id,
        group_id: group,
        id: opt("id") ?? `wamid.g.${Date.now()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "text",
        text: { body: opt("text") ?? "Hello group" },
      },
    ],
  });
} else if (kind.startsWith("group:status:")) {
  payload = status({
    id: opt("id") ?? "wamid.out1",
    status: kind.slice("group:status:".length),
    recipient_type: "group",
    recipient_id: group,
    recipient_participant_user_id: person.user_id,
    recipient_participant_id: person.wa_id,
    ...(opt("our-id") ? { biz_opaque_callback_data: opt("our-id") } : {}),
  });
} else if (kind === "group:created") {
  payload = groupHook("group_lifecycle_update", {
    type: "group_create",
    request_id: opt("request-id"),
    subject: opt("subject") ?? "VIP patients",
    invite_link: `https://chat.whatsapp.com/FAKE${Date.now()}`,
    join_approval_mode: "auto_approve",
  });
} else if (kind === "group:failed") {
  payload = groupHook("group_lifecycle_update", {
    type: "group_create",
    group_id: null,
    request_id: opt("request-id"),
    errors: [{ code: 131215, title: "Not eligible for groups" }],
  });
} else if (kind === "group:join") {
  payload = groupHook("group_participants_update", {
    type: "group_participants_add",
    reason: "invite_link",
    added_participants: [person],
  });
} else if (kind === "group:leave" || kind === "group:removed") {
  payload = groupHook("group_participants_update", {
    type: "group_participants_remove",
    initiated_by: kind === "group:leave" ? "participant" : "business",
    removed_participants: [person],
  });
} else if (kind === "group:join-request" || kind === "group:join-withdrawn") {
  payload = groupHook("group_participants_update", {
    type: kind === "group:join-request" ? "group_join_request_created" : "group_join_request_revoked",
    join_request_id: opt("request-id") ?? "JR1",
    ...person,
  });
} else if (kind === "group:subject") {
  payload = groupHook("group_settings_update", {
    request_id: opt("request-id"),
    group_subject: { text: opt("subject") ?? "Renamed", update_successful: true },
  });
} else if (kind === "group:suspend" || kind === "group:restore") {
  payload = groupHook("group_status_update", {
    type: kind === "group:suspend" ? "group_suspend" : "group_suspend_cleared",
  });
} else if (kind === "group:delete") {
  payload = groupHook("group_lifecycle_update", { type: "group_delete", request_id: opt("request-id") });
} else if (kind.startsWith("status:")) {
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
