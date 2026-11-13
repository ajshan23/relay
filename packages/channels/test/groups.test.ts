import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWhatsAppWebhook } from "../src/whatsapp/parse";
import { CUSTOMER, CUSTOMER_BSUID, envelope, incoming, messages, status, WABA } from "./fixtures";

// biome-ignore lint/suspicious/noExplicitAny: tests reach into whichever event variant came back
type Loose = Record<string, any>;
const GROUP = "120363000000000001";
const OTHER_BSUID = "US.1349000000000002";

const one = (payload: unknown) => {
  const events = parseWhatsAppWebhook(payload);
  assert.equal(events.length, 1, JSON.stringify(events));
  return events[0] as never as Loose;
};
const groupHook = (field: string, group: Record<string, unknown>) =>
  envelope({ groups: [{ timestamp: "1789380000", group_id: GROUP, ...group }] }, field);

describe("WhatsApp groups", () => {
  it("puts a group message in the group, with its sender as the participant", () => {
    const e = one(incoming({ ...(messages.text as object), group_id: GROUP } as never));
    assert.deepEqual(e.conversation, { kind: "group", groupExternalId: GROUP });
    assert.equal(e.from.externalId, CUSTOMER_BSUID);
    assert.equal(e.from.phone, CUSTOMER);
  });

  it("keeps direct messages direct", () => {
    assert.deepEqual(one(incoming(messages.text as never)).conversation, { kind: "direct" });
  });

  it("reports group statuses per participant", () => {
    const e = one(
      status({
        status: "read",
        recipient_type: "group",
        recipient_id: GROUP,
        recipient_participant_user_id: OTHER_BSUID,
        recipient_participant_id: "15550003333",
      }),
    );
    assert.equal(e.recipient.kind, "group");
    assert.equal(e.recipient.groupExternalId, GROUP);
    assert.deepEqual(
      [e.recipient.participant.externalId, e.recipient.participant.phone, e.recipient.participant.scope],
      [OTHER_BSUID, "15550003333", WABA],
    );
  });

  it("parses group creation, failure and deletion", () => {
    const created = one(
      groupHook("group_lifecycle_update", {
        type: "group_create",
        request_id: "REQ1",
        subject: "VIP patients",
        invite_link: "https://chat.whatsapp.com/ABC",
        join_approval_mode: "auto_approve",
      }),
    );
    assert.deepEqual(
      [created.kind, created.requestId, created.subject, created.inviteLink],
      ["group.created", "REQ1", "VIP patients", "https://chat.whatsapp.com/ABC"],
    );
    const failed = one(
      groupHook("group_lifecycle_update", {
        type: "group_create",
        group_id: null,
        request_id: "REQ2",
        errors: [{ code: 131215, title: "Not eligible" }],
      }),
    );
    assert.deepEqual(
      [failed.kind, failed.operation, failed.errors[0].code],
      ["group.failed", "create", 131215],
    );
    assert.equal(
      one(groupHook("group_lifecycle_update", { type: "group_delete", request_id: "REQ3" })).kind,
      "group.deleted",
    );
  });

  it("parses people joining, leaving and being removed", () => {
    const added = one(
      groupHook("group_participants_update", {
        type: "group_participants_add",
        reason: "invite_link",
        added_participants: [
          { user_id: CUSTOMER_BSUID, wa_id: CUSTOMER },
          { user_id: OTHER_BSUID, username: "omar" },
        ],
      }),
    );
    assert.equal(added.kind, "group.participants_added");
    assert.deepEqual(
      added.participants.map((p: Loose) => [p.externalId, p.phone, p.username]),
      [
        [CUSTOMER_BSUID, CUSTOMER, null],
        [OTHER_BSUID, null, "omar"],
      ],
    );
    const left = one(
      groupHook("group_participants_update", {
        type: "group_participants_remove",
        initiated_by: "participant",
        removed_participants: [{ user_id: OTHER_BSUID }],
      }),
    );
    assert.deepEqual(
      [left.kind, left.initiatedBy, left.participants.length],
      ["group.participants_removed", "participant", 1],
    );
    const partly = one(
      groupHook("group_participants_update", {
        type: "group_participants_remove",
        initiated_by: "business",
        removed_participants: [],
        failed_participants: [
          { input: "15550004444", user_id: "US.X", errors: [{ code: 100, title: "Invalid" }] },
        ],
      }),
    );
    assert.equal(partly.failed[0].errors[0].code, 100);
  });

  it("parses join requests and withdrawals", () => {
    const req = one(
      groupHook("group_participants_update", {
        type: "group_join_request_created",
        join_request_id: "JR1",
        user_id: OTHER_BSUID,
        wa_id: "15550003333",
      }),
    );
    assert.deepEqual(
      [req.kind, req.requestExternalId, req.participant.externalId],
      ["group.join_requested", "JR1", OTHER_BSUID],
    );
    assert.equal(
      one(
        groupHook("group_participants_update", {
          type: "group_join_request_revoked",
          join_request_id: "JR1",
          user_id: OTHER_BSUID,
        }),
      ).kind,
      "group.join_request_withdrawn",
    );
  });

  it("parses settings results section by section", () => {
    const ok = one(
      groupHook("group_settings_update", {
        request_id: "REQ4",
        group_subject: { text: "VIP patients 2026", update_successful: true },
        group_description: { text: "x", update_successful: false, errors: [{ code: 1, title: "too long" }] },
      }),
    );
    assert.deepEqual(
      [ok.kind, ok.subject, ok.description, ok.errors.length],
      ["group.updated", "VIP patients 2026", undefined, 1],
    );
    const bad = one(
      groupHook("group_settings_update", {
        request_id: "REQ5",
        group_subject: { text: "", update_successful: false, errors: [{ code: 2, title: "empty" }] },
      }),
    );
    assert.deepEqual([bad.kind, bad.operation], ["group.failed", "update"]);
  });

  it("parses suspension and its end", () => {
    assert.equal(one(groupHook("group_status_update", { type: "group_suspend" })).kind, "group.suspended");
    assert.equal(
      one(groupHook("group_status_update", { type: "group_suspend_cleared" })).kind,
      "group.restored",
    );
  });
});
