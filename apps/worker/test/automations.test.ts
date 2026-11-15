import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type AutomationDefinition,
  emptyDefinition,
  type InboundEventPayload,
} from "@relay/core/automations";
import { createDb, eq, schema, sql } from "@relay/db";
import { createAutomations } from "../src/automations/runtime";

/*
 * Automations end to end on a throwaway database (the local drill DB, never Relay's real data):
 * a customer message starts the right automation, the question goes out with buttons, a tap is read,
 * the next step sends, the chat is handed back; a wrong answer re-asks; STOP ends the run; a repeated
 * webhook changes nothing. The outbox is faked (nothing is sent anywhere).
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const queued: string[] = [];
const outbox = { add: async (_: string, d: { messageId: string }) => queued.push(d.messageId) };
const automations = createAutomations({
  db,
  redis: { publish: async () => 0 },
  outbox: outbox as never,
  outboxJobOptions: {},
  databaseUrl: URL,
  listenUrl: URL,
});
const worker = automations.worker();

const T = Date.now().toString(36);
const ids = {
  org: `org_t${T}`,
  branch: `br_t${T}`,
  channel: `ch_t${T}`,
  automation: `aut_t${T}`,
  version: `autv_t${T}`,
};
let contactSeq = 0;

async function newChat() {
  contactSeq++;
  const contactId = `ct_t${T}_${contactSeq}`;
  const identityId = `cid_t${T}_${contactSeq}`;
  const conversationId = `conv_t${T}_${contactSeq}`;
  await db.insert(schema.contact).values({
    id: contactId,
    organizationId: ids.org,
    branchId: ids.branch,
    name: "Asha Rao",
    phone: `9198470${contactSeq}`,
  });
  await db.insert(schema.contactIdentity).values({
    id: identityId,
    organizationId: ids.org,
    contactId,
    branchId: ids.branch,
    channelType: "whatsapp",
    scope: "waba",
    externalId: `9198470${contactSeq}`,
  });
  await db.insert(schema.conversation).values({
    id: conversationId,
    organizationId: ids.org,
    branchId: ids.branch,
    channelAccountId: ids.channel,
    kind: "direct",
    contactId,
    contactIdentityId: identityId,
    status: "open",
    windowExpiresAt: new Date(Date.now() + 86_400_000),
  });
  return { contactId, conversationId };
}

let msgSeq = 0;
/** What ingest does for a customer message: store it, then hand it to automations in the same transaction. */
async function customerSays(
  chat: { contactId: string; conversationId: string },
  text: string,
  reply: { id: string; title: string } | null = null,
  messageId = `msg_t${T}_${++msgSeq}`,
) {
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.message)
      .values({
        id: messageId,
        organizationId: ids.org,
        conversationId: chat.conversationId,
        channelAccountId: ids.channel,
        direction: "inbound",
        senderType: "contact",
        type: reply ? "interactive" : "text",
        content: { type: "text", text },
        status: "received",
        sentAt: new Date(),
      })
      .onConflictDoNothing();
    const ev: InboundEventPayload = {
      messageId,
      organizationId: ids.org,
      branchId: ids.branch,
      channelAccountId: ids.channel,
      conversationId: chat.conversationId,
      contactId: chat.contactId,
      type: reply ? "interactive" : "text",
      text,
      reply,
      adId: null,
      optOut: text.trim().toUpperCase() === "STOP" ? "stop" : null,
    };
    await automations.onInbound(tx as never, ev);
  });
  return messageId;
}

async function botMessages(conversationId: string) {
  return db
    .select()
    .from(schema.message)
    .where(sql`${schema.message.conversationId} = ${conversationId} and ${schema.message.senderType} = 'bot'`)
    .orderBy(schema.message.createdAt);
}

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const runOf = async (conversationId: string) => {
  const runs = await automations.kairos.listRuns({
    labels: { conversationId },
    workflow: "relay.automation",
  });
  return runs[0] ?? null;
};

function welcomeMenu(): AutomationDefinition {
  const def = emptyDefinition({
    type: "message_received",
    mode: "keyword",
    keywords: ["hi"],
    match: "exact",
  });
  def.rules = { ...def.rules, skipIfAssigned: false };
  def.nodes = [
    {
      id: "ask",
      type: "ask_question",
      version: 1,
      config: {
        text: "Hi {{contact.first_name}}! What do you need?",
        answer: {
          type: "buttons",
          options: [
            { id: "a1", title: "Prices" },
            { id: "a2", title: "Talk to us" },
          ],
        },
        saveAs: "need",
        retries: 1,
        retryText: "Please tap one of the buttons.",
        timeoutMinutes: 60,
      },
    },
    {
      id: "prices",
      type: "send_message",
      version: 1,
      config: { text: "Here is the price list ({{answers.need}}).", media: null },
    },
    { id: "tag", type: "add_tag", version: 1, config: { tagId: `tag_t${T}` } },
    { id: "human", type: "handoff", version: 1, config: { userId: null, note: "Wants to talk" } },
    { id: "bye", type: "end", version: 1, config: {} },
  ];
  def.edges = [
    { id: "e1", source: "trigger", sourceHandle: "next", target: "ask" },
    { id: "e2", source: "ask", sourceHandle: "opt:a1", target: "prices" },
    { id: "e3", source: "prices", sourceHandle: "next", target: "tag" },
    { id: "e4", source: "ask", sourceHandle: "opt:a2", target: "human" },
    { id: "e5", source: "ask", sourceHandle: "invalid", target: "bye" },
    { id: "e6", source: "ask", sourceHandle: "no_reply", target: "bye" },
  ];
  return def;
}

before(async () => {
  await pg.unsafe("drop schema if exists kairos cascade");
  await db
    .insert(schema.organization)
    .values({ id: ids.org, name: "Lumen Test", slug: `lumen-t${T}`, createdAt: new Date() });
  await db
    .insert(schema.branch)
    .values({ id: ids.branch, organizationId: ids.org, name: "Marina", slug: `marina-t${T}` });
  await db.insert(schema.channelAccount).values({
    id: ids.channel,
    organizationId: ids.org,
    type: "whatsapp",
    provider: "meta",
    externalId: `pn_t${T}`,
    displayName: "Lumen test",
    credentials: "test",
    status: "active",
    defaultBranchId: ids.branch,
  });
  const def = welcomeMenu();
  await db.insert(schema.automation).values({
    id: ids.automation,
    organizationId: ids.org,
    branchId: ids.branch,
    name: "Welcome menu",
    channelAccountId: ids.channel,
    status: "live",
    draft: def,
    liveVersionId: ids.version,
    triggerType: "message_received",
  });
  await db.insert(schema.automationVersion).values({
    id: ids.version,
    automationId: ids.automation,
    organizationId: ids.org,
    number: 1,
    definition: def,
    checksum: "test",
  });
  await automations.startWorker(worker);
});

after(async () => {
  await automations.kairos.close();
  await db.delete(schema.organization).where(eq(schema.organization.id, ids.org));
  await pg.end();
});

describe("automations on Kairos", () => {
  it("starts on the keyword, asks with buttons, reads the tap, sends and hands the chat back", async () => {
    const chat = await newChat();
    await customerSays(chat, "Hi");
    const [question] = await until("the question", async () => {
      const m = await botMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.equal(question?.type, "interactive");
    const content = question?.content as {
      body: string;
      kind: string;
      options: { id: string; title: string }[];
    };
    assert.equal(content.body, "Hi Asha! What do you need?");
    assert.equal(content.kind, "buttons");
    assert.ok(queued.includes(question?.id ?? ""));
    const [conv] = await db
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.id, chat.conversationId));
    assert.ok(conv?.automationRunId, "the run is in charge of the chat");

    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "Prices", { id: content.options[0]?.id ?? "", title: "Prices" });
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r && ["completed", "failed"].includes(r.status) ? r : null;
    });
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    const sent = await botMessages(chat.conversationId);
    assert.deepEqual(
      sent.map((m) => (m.content as { text?: string }).text ?? m.type),
      ["interactive", "Here is the price list (Prices)."],
    );
    const [contact] = await db.select().from(schema.contact).where(eq(schema.contact.id, chat.contactId));
    assert.deepEqual(contact?.tagIds, [`tag_t${T}`]);
    const [after] = await db
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.id, chat.conversationId));
    assert.equal(after?.automationRunId, null, "the chat is handed back");
  });

  it("re-asks after an answer that doesn't fit, then takes the didn't-understand way", async () => {
    const chat = await newChat();
    await customerSays(chat, "hi");
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "maybe later");
    await until("the re-ask", async () => (await botMessages(chat.conversationId)).length === 2);
    const second = (await botMessages(chat.conversationId))[1];
    assert.equal((second?.content as { body?: string } | undefined)?.body, "Please tap one of the buttons.");
    await until(
      "the run to wait again",
      async () => (await runOf(chat.conversationId))?.status === "waiting",
    );
    await customerSays(chat, "no idea");
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r && r.status === "completed" ? r : null;
    });
    assert.deepEqual((run.output as { path: string[] }).path, ["ask:invalid", "bye:end"]);
  });

  it("counts a typed option title as the answer, and ignores a tap on an older question's button", async () => {
    const chat = await newChat();
    await customerSays(chat, "hi");
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "Prices", { id: "qold_a1", title: "Prices" }); // a stale button: invalid
    await until("the re-ask", async () => (await botMessages(chat.conversationId)).length === 2);
    await until(
      "the run to wait again",
      async () => (await runOf(chat.conversationId))?.status === "waiting",
    );
    await customerSays(chat, "talk to us");
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r && r.status === "completed" ? r : null;
    });
    assert.deepEqual((run.output as { path: string[] }).path, ["ask:opt:a2", "human:end"]);
    const notes = await botMessages(chat.conversationId);
    assert.ok(notes.some((m) => m.type === "note"));
  });

  it("stops the run when the customer sends STOP", async () => {
    const chat = await newChat();
    await customerSays(chat, "hi");
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "STOP");
    await until(
      "the run to be cancelled",
      async () => (await runOf(chat.conversationId))?.status === "cancelled",
    );
    const [conv] = await db
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.id, chat.conversationId));
    assert.equal(conv?.automationRunId, null);
  });

  it("does nothing twice for a repeated webhook, and starts nothing for a message that matches no trigger", async () => {
    const chat = await newChat();
    const id = await customerSays(chat, "hi");
    await customerSays(chat, "hi", null, id);
    await until("the question", async () => (await botMessages(chat.conversationId)).length === 1);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await botMessages(chat.conversationId)).length, 1);
    const routes = await automations.kairos.listRuns({
      labels: { conversationId: chat.conversationId },
      workflow: "relay.route",
    });
    assert.equal(routes.length, 1);

    const quiet = await newChat();
    await customerSays(quiet, "hello there");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await runOf(quiet.conversationId), null);
  });

  it("starts a tag automation in the contact's chat on its number", async () => {
    const def = emptyDefinition({ type: "tag_added", tagId: `vip_t${T}` });
    def.rules = { ...def.rules, skipIfAssigned: false };
    def.nodes = [{ id: "note", type: "add_note", version: 1, config: { text: "VIP: {{contact.name}}" } }];
    def.edges = [{ id: "t1", source: "trigger", sourceHandle: "next", target: "note" }];
    await db.insert(schema.automation).values({
      id: `${ids.automation}_tag`,
      organizationId: ids.org,
      branchId: ids.branch,
      name: "VIP welcome",
      channelAccountId: ids.channel,
      status: "live",
      draft: def,
      liveVersionId: `${ids.version}_tag`,
      triggerType: "tag_added",
    });
    await db.insert(schema.automationVersion).values({
      id: `${ids.version}_tag`,
      automationId: `${ids.automation}_tag`,
      organizationId: ids.org,
      number: 1,
      definition: def,
      checksum: "test",
    });
    const chat = await newChat();
    await automations.kairos.start(
      automations.router,
      {
        kind: "tag",
        organizationId: ids.org,
        branchId: ids.branch,
        contactId: chat.contactId,
        tagId: `vip_t${T}`,
        eventId: "1",
      },
      { tenantId: ids.org, serialKey: `contact:${chat.contactId}` },
    );
    const notes = await until("the note", async () => {
      const m = (await botMessages(chat.conversationId)).filter((x) => x.type === "note");
      return m.length ? m : null;
    });
    assert.equal((notes[0]?.content as { text: string } | undefined)?.text, "VIP: Asha Rao");
  });

  async function liveAutomation(suffix: string, def: AutomationDefinition) {
    const id = `${ids.automation}_${suffix}`;
    await db.insert(schema.automation).values({
      id,
      organizationId: ids.org,
      branchId: ids.branch,
      name: suffix,
      channelAccountId: ids.channel,
      status: "live",
      draft: def,
      liveVersionId: `${ids.version}_${suffix}`,
      triggerType: def.trigger.type,
      priority: 30,
    });
    await db.insert(schema.automationVersion).values({
      id: `${ids.version}_${suffix}`,
      automationId: id,
      organizationId: ids.org,
      number: 1,
      definition: def,
      checksum: "test",
    });
  }

  it("waits for a reply after a text, saves it, and goes on", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["check"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    def.nodes = [
      {
        id: "msg",
        type: "send_message",
        version: 1,
        config: { text: "How are you?", media: null, waitForReply: true, saveAs: "mood", timeoutMinutes: 60 },
      },
      { id: "note", type: "add_note", version: 1, config: { text: "Mood: {{answers.mood}}" } },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "msg" },
      { id: "2", source: "msg", sourceHandle: "replied", target: "note" },
      { id: "3", source: "msg", sourceHandle: "no_reply", target: "bye" },
    ];
    await liveAutomation("reply", def);
    const chat = await newChat();
    await customerSays(chat, "check");
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "fine thanks");
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.deepEqual((run.output as { path: string[] }).path, ["msg:replied", "note:next"]);
    const note = (await botMessages(chat.conversationId)).find((m) => m.type === "note");
    assert.equal((note?.content as { text?: string } | undefined)?.text, "Mood: fine thanks");
  });

  /** Waits until every router run of this chat has finished, and returns their decisions. */
  async function routed(conversationId: string, count: number) {
    return until(`${count} routed messages`, async () => {
      const runs = await automations.kairos.listRuns({ workflow: "relay.route", labels: { conversationId } });
      if (runs.length < count || runs.some((r) => r.status !== "completed")) return null;
      const steps = await Promise.all(runs.map((r) => automations.kairos.getRun(r.id)));
      return steps.map((g) => g?.steps[0]?.result as { action: string });
    });
  }

  it("takes a keyword typed as an answer as the answer only, never as a new start", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["again"],
      match: "exact",
    });
    def.nodes = [
      {
        id: "msg",
        type: "send_message",
        version: 1,
        config: { text: "Say anything", media: null, waitForReply: true, saveAs: "", timeoutMinutes: 60 },
      },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "msg" },
      { id: "2", source: "msg", sourceHandle: "replied", target: "bye" },
      { id: "3", source: "msg", sourceHandle: "no_reply", target: "bye" },
    ];
    await liveAutomation("again", def);
    const chat = await newChat();
    await customerSays(chat, "again");
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    // The answer is also the keyword. The run finishes on it before its router step runs.
    await customerSays(chat, "again");
    const decisions = await routed(chat.conversationId, 2);
    assert.deepEqual(decisions.map((d) => d.action).sort(), ["answered", "started"]);
    const runs = await automations.kairos.listRuns({
      workflow: "relay.automation",
      labels: { conversationId: chat.conversationId },
    });
    assert.equal(runs.length, 1, "the answer must not start a second run");
  });

  it("doesn't count test runs for 'Only once'", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["once"],
      match: "exact",
    });
    def.rules = { ...def.rules, reentry: "once" };
    def.nodes = [{ id: "hi", type: "send_message", version: 1, config: { text: "Hello once", media: null } }];
    def.edges = [{ id: "1", source: "trigger", sourceHandle: "next", target: "hi" }];
    await liveAutomation("once", def);
    const chat = await newChat();
    const [conv] = await db
      .select()
      .from(schema.conversation)
      .where(sql`${schema.conversation.id} = ${chat.conversationId}`);
    if (!conv) throw new Error("no chat");
    // Tried out from the editor on this contact first.
    const testRun = await automations.startRun({
      def,
      versionId: `${ids.version}_once`,
      automationId: `${ids.automation}_once`,
      conversation: conv,
      contactId: chat.contactId,
      idempotencyKey: `test:${chat.conversationId}`,
      trigger: { kind: "manual", startedByUserId: "usr_test" },
      test: true,
    });
    await until(
      "the test run",
      async () => (await automations.kairos.getRun(testRun))?.run.status === "completed",
    );
    await customerSays(chat, "once");
    await routed(chat.conversationId, 1);
    await until(
      "the real run to finish",
      async () => (await runOf(chat.conversationId))?.status === "completed",
    );
    await customerSays(chat, "once");
    const decisions = await routed(chat.conversationId, 2);
    assert.deepEqual(
      decisions.map((d) => d.action).sort(),
      ["skipped", "started"],
      "the real first time starts; the second is 'already entered'",
    );
  });

  it("sends a template whose quick-reply buttons each lead their own way", async () => {
    await db.insert(schema.messageTemplate).values({
      id: `tpl_t${T}`,
      organizationId: ids.org,
      name: "Offer",
      slug: "offer",
      language: "en",
      purpose: "marketing",
      content: {
        body: "Hi {{name}}, want 20% off?",
        buttons: [
          { kind: "reply", text: "Yes please" },
          { kind: "link", text: "See it", url: "https://example.com" },
          { kind: "reply", text: "No thanks" },
        ],
      },
      variables: [{ name: "name", example: "Asha" }],
    });
    await db.insert(schema.templateChannel).values({
      id: `tpc_t${T}`,
      organizationId: ids.org,
      templateId: `tpl_t${T}`,
      channelAccountId: ids.channel,
      scope: "waba",
      status: "ready",
    });
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["offer"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    def.nodes = [
      {
        id: "tpl",
        type: "send_template",
        version: 1,
        config: {
          templateId: `tpl_t${T}`,
          values: { name: "{{contact.first_name}}" },
          replyButtons: [
            { index: 0, title: "Yes please" },
            { index: 2, title: "No thanks" },
          ],
          waitForReply: true,
          saveAs: "pick",
          timeoutMinutes: 60,
        },
      },
      { id: "yes", type: "add_note", version: 1, config: { text: "Booked" } },
      { id: "no", type: "add_note", version: 1, config: { text: "Declined ({{answers.pick}})" } },
      { id: "other", type: "add_note", version: 1, config: { text: "Other: {{answers.pick}}" } },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "tpl" },
      { id: "2", source: "tpl", sourceHandle: "btn:0", target: "yes" },
      { id: "3", source: "tpl", sourceHandle: "btn:2", target: "no" },
      { id: "4", source: "tpl", sourceHandle: "replied", target: "other" },
      { id: "5", source: "tpl", sourceHandle: "no_reply", target: "bye" },
    ];
    await liveAutomation("offer", def);
    const chat = await newChat();
    await customerSays(chat, "offer");
    const [sent] = await until("the template", async () => {
      const m = (await botMessages(chat.conversationId)).filter((x) => x.type === "template");
      return m.length ? m : null;
    });
    const content = sent?.content as {
      body?: string;
      quickReplyPayloads?: { index: number; payload: string }[];
    };
    assert.equal(content.body, "Hi Asha, want 20% off?");
    assert.deepEqual(
      content.quickReplyPayloads?.map((q) => q.index),
      [0, 2],
    );
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    // The customer taps "No thanks": WhatsApp sends back our payload for button 2.
    const payload = content.quickReplyPayloads?.find((q) => q.index === 2)?.payload ?? "";
    await customerSays(chat, "No thanks", { id: payload, title: "No thanks" });
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.deepEqual((run.output as { path: string[] }).path, ["tpl:btn:2", "no:next"]);
    const note = (await botMessages(chat.conversationId)).find((m) => m.type === "note");
    assert.equal((note?.content as { text?: string } | undefined)?.text, "Declined (No thanks)");
  });
});
