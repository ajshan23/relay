import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  type AutomationDefinition,
  automationEvents,
  emptyDefinition,
  type InboundEventPayload,
  utilityDefaults,
} from "@relay/core/automations";
import { createDb, eq, recordLinkTap, schema, sql, sqlExecutor } from "@relay/db";
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
const typing: { messageId: string; at: number }[] = [];
const signals = {
  add: async (_: string, d: { kind: string; messageId: string }) => {
    if (d.kind === "typing") typing.push({ messageId: d.messageId, at: Date.now() });
    return {} as never;
  },
};
const automations = createAutomations({
  db,
  redis: { publish: async () => 0 },
  outbox: outbox as never,
  outboxJobOptions: {},
  databaseUrl: URL,
  listenUrl: URL,
  signals,
  canType: () => true,
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
  /** WhatsApp's id for it; typing can only answer a message that has one. */
  externalId: string | null = null,
  /** The message a tapped button belongs to (WhatsApp sends this with every button tap). */
  replyToMessageId: string | null = null,
  /** When they sent it (WhatsApp's time), if not just now. */
  sentAt: Date | null = null,
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
        externalId,
        replyToMessageId,
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
      ...(sentAt ? { sentAt: sentAt.toISOString() } : {}),
    };
    await automations.onInbound(tx as never, ev);
  });
  return messageId;
}

/** The customer shares a pin (WhatsApp's "Send location"). */
async function customerSharesLocation(
  chat: { contactId: string; conversationId: string },
  pin: { latitude: number; longitude: number; name: string | null; address: string | null },
) {
  const messageId = `msg_t${T}_${++msgSeq}`;
  await db.transaction(async (tx) => {
    await tx.insert(schema.message).values({
      id: messageId,
      organizationId: ids.org,
      conversationId: chat.conversationId,
      channelAccountId: ids.channel,
      direction: "inbound",
      senderType: "contact",
      type: "location",
      content: { type: "location", ...pin, url: null },
      status: "received",
      sentAt: new Date(),
    });
    await automations.onInbound(tx as never, {
      messageId,
      organizationId: ids.org,
      branchId: ids.branch,
      channelAccountId: ids.channel,
      conversationId: chat.conversationId,
      contactId: chat.contactId,
      type: "location",
      text: "",
      reply: null,
      adId: null,
      optOut: null,
      location: pin,
    });
  });
}

/** A tap on a tracked link, as GET /l/<code> records it. */
const tapLink = (code: string) =>
  recordLinkTap(db, code, async (tx, link) => {
    await automations.kairos.publish(
      {
        tenantId: link.organizationId,
        key: automationEvents.linkTapped,
        scope: link.stepKey,
        payload: { linkId: link.id, at: new Date().toISOString() },
        dedupeKey: `link:${link.code}`,
      },
      { executor: sqlExecutor(tx) },
    );
  });

/** Makes a run's open wait time out now (instead of waiting minutes in a test). */
async function timeOutWait(runId: string) {
  await db.execute(sql`update kairos.wait set deadline = now() where run_id = ${runId} and status = 'open'`);
  await db.execute(sql`update kairos.wakeup set wake_at = now() where run_id = ${runId}`);
  automations.kairos.nudge();
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
    if (!testRun) throw new Error("the test run didn't start");
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

  it("shows typing on the customer's message, pauses about as long as typing takes, then sends", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["typey"],
      match: "exact",
    });
    const text = "Thanks for writing, we will get back to you shortly"; // 51 chars → 1.17 s
    def.nodes = [{ id: "hi", type: "send_message", version: 1, config: { text, media: null } }];
    def.edges = [{ id: "1", source: "trigger", sourceHandle: "next", target: "hi" }];
    await liveAutomation("typey", def);
    const chat = await newChat();
    const inbound = await customerSays(chat, "typey", null, undefined, `wamid.typey${T}`);
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    const shown = typing.find((t) => t.messageId === inbound);
    assert.ok(shown, "typing was queued on the customer's message");
    const [sent] = await botMessages(chat.conversationId);
    const gap = new Date(sent?.createdAt ?? 0).getTime() - shown.at;
    assert.ok(gap >= 1_100 && gap < 2_400, `the message went out ${gap} ms after typing started`);
    const names = (await automations.kairos.getRun(run.id))?.steps.map((s) => s.name);
    assert.deepEqual(names?.slice(0, 3), [
      "send_message:hi#1:typing",
      "send_message:hi#1:pause",
      "send_message:hi#1",
    ]);
  });

  it("doesn't type when the automation has typing off", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["quiet"],
      match: "exact",
    });
    def.rules = { ...def.rules, typing: false };
    def.nodes = [{ id: "hi", type: "send_message", version: 1, config: { text: "Hello", media: null } }];
    def.edges = [{ id: "1", source: "trigger", sourceHandle: "next", target: "hi" }];
    await liveAutomation("quiet", def);
    const chat = await newChat();
    const inbound = await customerSays(chat, "quiet", null, undefined, `wamid.quiet${T}`);
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.equal(
      typing.find((t) => t.messageId === inbound),
      undefined,
    );
    const names = (await automations.kairos.getRun(run.id))?.steps.map((s) => s.name);
    assert.equal(names?.[0], "send_message:hi#1");
  });

  /** Menu → "Book" (a message waiting for a reply) or "Talk" (hand to a human). */
  function bookOrTalk(keyword: string): AutomationDefinition {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: [keyword],
      match: "exact",
    });
    def.rules = { ...def.rules, typing: false, skipIfAssigned: false };
    def.nodes = [
      {
        id: "menu",
        type: "ask_question",
        version: 1,
        config: {
          text: "How can we help?",
          answer: {
            type: "buttons",
            options: [
              { id: "a1", title: "Book" },
              { id: "a2", title: "Talk" },
            ],
          },
          saveAs: "choice",
          retries: 1,
          retryText: "Pick one",
          timeoutMinutes: 60,
        },
      },
      {
        id: "book",
        type: "send_message",
        version: 1,
        config: { text: "Book here", media: null, waitForReply: true, saveAs: "", timeoutMinutes: 60 },
      },
      { id: "human", type: "handoff", version: 1, config: { note: "Wants a person", userId: null } },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "menu" },
      { id: "2", source: "menu", sourceHandle: "opt:a1", target: "book" },
      { id: "3", source: "menu", sourceHandle: "opt:a2", target: "human" },
      { id: "4", source: "menu", sourceHandle: "invalid", target: "bye" },
      { id: "5", source: "menu", sourceHandle: "no_reply", target: "bye" },
      { id: "6", source: "book", sourceHandle: "replied", target: "bye" },
      { id: "7", source: "book", sourceHandle: "no_reply", target: "bye" },
    ];
    return def;
  }

  /** The menu message the bot sent, and the reply id of one of its buttons. */
  async function menuButton(conversationId: string, title: string, nth = 0) {
    const menus = await until("the menu", async () => {
      const m = (await botMessages(conversationId)).filter((x) => x.type === "interactive");
      return m.length > nth ? m : null;
    });
    const menu = menus[nth];
    const option = (
      menu?.content as { options?: { id: string; title: string }[] } | undefined
    )?.options?.find((o) => o.title === title);
    if (!menu || !option) throw new Error(`no ${title} button`);
    return { menuId: menu.id, replyId: option.id };
  }

  const runsOf = (conversationId: string) =>
    automations.kairos.listRuns({ workflow: "relay.automation", labels: { conversationId } });

  it("follows a tap on an earlier menu's button: Book a visit, then Talk to someone hands over", async () => {
    await liveAutomation("booktalk", bookOrTalk("booktalk"));
    const chat = await newChat();
    await customerSays(chat, "booktalk");
    const book = await menuButton(chat.conversationId, "Book");
    await customerSays(chat, "Book", { id: book.replyId, title: "Book" }, undefined, null, book.menuId);
    await until("the booking message", async () =>
      (await botMessages(chat.conversationId)).some(
        (m) => (m.content as { text?: string }).text === "Book here",
      ),
    );
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    // Scrolls up and taps "Talk" on the same menu while the bot waits for a reply to "Book here".
    const talk = await menuButton(chat.conversationId, "Talk");
    await customerSays(chat, "Talk", { id: talk.replyId, title: "Talk" }, undefined, null, talk.menuId);
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    const out = run.output as { path: string[]; answers: Record<string, string> };
    assert.deepEqual(out.path, ["menu:opt:a1", "book:older_button", "menu:opt:a2", "human:end"]);
    assert.equal(out.answers.choice, "Talk");
    assert.equal((await runsOf(chat.conversationId)).length, 1, "the same run carried on");
  });

  it("starts again at the tapped choice when that run has ended, or from the top when the choice is gone", async () => {
    await liveAutomation("ended", bookOrTalk("ended"));
    const chat = await newChat();
    await customerSays(chat, "ended");
    const book = await menuButton(chat.conversationId, "Book");
    await customerSays(chat, "Book", { id: book.replyId, title: "Book" }, undefined, null, book.menuId);
    await until("the booking message", async () =>
      (await botMessages(chat.conversationId)).some(
        (m) => (m.content as { text?: string }).text === "Book here",
      ),
    );
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "thanks");
    await until("the run to finish", async () => (await runOf(chat.conversationId))?.status === "completed");

    // Later they tap "Talk" on that old menu: a new run starts right at "Talk".
    const talk = await menuButton(chat.conversationId, "Talk");
    await customerSays(chat, "Talk", { id: talk.replyId, title: "Talk" }, undefined, null, talk.menuId);
    const second = await until("a second run", async () => {
      const runs = await runsOf(chat.conversationId);
      return runs.length === 2 && runs[0]?.status === "completed" ? runs[0] : null;
    });
    assert.deepEqual((second.output as { path: string[] }).path, [
      "trigger:older_button",
      "menu:opt:a2",
      "human:end",
    ]);
    assert.equal((second.input as { trigger: { kind: string } }).trigger.kind, "button");

    // A button whose option isn't in the live version any more: they get the current menu again.
    await customerSays(
      chat,
      "Old",
      { id: talk.replyId.replace(/_a2$/, "_gone"), title: "Old" },
      undefined,
      null,
      talk.menuId,
    );
    await until("a third run asking again", async () => {
      const runs = await runsOf(chat.conversationId);
      return runs.length === 3 && runs[0]?.status === "waiting";
    });
    await menuButton(chat.conversationId, "Book", 1);
  });

  it("takes an answer typed while the bot is still typing the question", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["eager"],
      match: "exact",
    });
    def.nodes = [
      {
        id: "q",
        type: "ask_question",
        version: 1,
        config: {
          text: "Shall we call you back?",
          answer: {
            type: "buttons",
            options: [
              { id: "a1", title: "Yes" },
              { id: "a2", title: "No" },
            ],
          },
          saveAs: "callback",
          retries: 1,
          retryText: "Pick one",
          timeoutMinutes: 60,
        },
      },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "q" },
      { id: "2", source: "q", sourceHandle: "opt:a1", target: "bye" },
      { id: "3", source: "q", sourceHandle: "opt:a2", target: "bye" },
      { id: "4", source: "q", sourceHandle: "invalid", target: "bye" },
      { id: "5", source: "q", sourceHandle: "no_reply", target: "bye" },
    ];
    await liveAutomation("eager", def);
    const chat = await newChat();
    await customerSays(chat, "eager", null, undefined, `wamid.eager${T}`);
    // While "typing…" shows (the pause before the question), they already type "yes".
    await until("the pause before the question", async () => {
      const r = await runOf(chat.conversationId);
      const steps = r ? (await automations.kairos.getRun(r.id))?.steps : [];
      return steps?.some((s) => s.name === "ask_question:q#1:pause" && s.status === "waiting");
    });
    await customerSays(chat, "yes");
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    const out = run.output as { path: string[]; answers: Record<string, string> };
    assert.deepEqual(out.path, ["q:opt:a1", "bye:end"]);
    assert.equal(out.answers.callback, "Yes");
  });

  it("lets a message sent before the question appeared pass, instead of asking again", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["twice"],
      match: "exact",
    });
    def.nodes = [
      {
        id: "q",
        type: "ask_question",
        version: 1,
        config: {
          text: "How can we help?",
          answer: {
            type: "buttons",
            options: [
              { id: "a1", title: "Prices" },
              { id: "a2", title: "Talk" },
            ],
          },
          saveAs: "need",
          retries: 1,
          retryText: "Please pick one of the options.",
          timeoutMinutes: 60,
        },
      },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "q" },
      { id: "2", source: "q", sourceHandle: "opt:a1", target: "bye" },
      { id: "3", source: "q", sourceHandle: "opt:a2", target: "bye" },
      { id: "4", source: "q", sourceHandle: "invalid", target: "bye" },
      { id: "5", source: "q", sourceHandle: "no_reply", target: "bye" },
    ];
    await liveAutomation("twice", def);
    const chat = await newChat();
    await customerSays(chat, "twice", null, undefined, `wamid.twice${T}`);
    // A second message while "typing…" shows: they haven't seen the question yet.
    await until("the pause before the question", async () => {
      const r = await runOf(chat.conversationId);
      const steps = r ? (await automations.kairos.getRun(r.id))?.steps : [];
      return steps?.some((s) => s.name === "ask_question:q#1:pause" && s.status === "waiting");
    });
    await customerSays(chat, "twice");
    await until("the run to wait for the answer", async () => {
      const r = await runOf(chat.conversationId);
      const steps = r ? (await automations.kairos.getRun(r.id))?.steps : [];
      return steps?.some((s) => s.name.startsWith("ask_question:q#1:answer0~") && s.status === "waiting");
    });
    const asked = (await botMessages(chat.conversationId)).filter((m) => m.type === "interactive");
    assert.equal(asked.length, 1, "no 'Please pick one' for a message sent before the question");
    // One more sent before the question, that Meta passed on only after it went out: still let pass.
    await customerSays(chat, "twice", null, undefined, null, null, new Date(Date.now() - 5_000));
    await until("the run to wait again", async () => {
      const r = await runOf(chat.conversationId);
      const steps = r ? (await automations.kairos.getRun(r.id))?.steps : [];
      return steps?.some((s) => s.name === "ask_question:q#1:answer0~2" && s.status === "waiting");
    });
    assert.equal(
      (await botMessages(chat.conversationId)).filter((m) => m.type === "interactive").length,
      1,
      "a message sent before the question but delivered late isn't a wrong answer",
    );
    // A wrong answer after seeing the question is still asked again.
    await customerSays(chat, "hello");
    await until("the re-ask", async () => {
      const m = (await botMessages(chat.conversationId)).filter((x) => x.type === "interactive");
      return m.length === 2 ? m : null;
    });
    await customerSays(chat, "Prices");
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.deepEqual((run.output as { path: string[] }).path, ["q:opt:a1", "bye:end"]);
  });

  it("never lets a second run take a chat that a run is in charge of", async () => {
    const def = bookOrTalk("busy");
    await liveAutomation("busy", def);
    const chat = await newChat();
    await customerSays(chat, "busy");
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    const [conv] = await db
      .select()
      .from(schema.conversation)
      .where(sql`${schema.conversation.id} = ${chat.conversationId}`);
    if (!conv) throw new Error("no chat");
    const second = await automations.startRun({
      def,
      versionId: `${ids.version}_busy`,
      automationId: `${ids.automation}_busy`,
      conversation: { ...conv, automationRunId: null }, // as if read before the first run took it
      contactId: chat.contactId,
      idempotencyKey: `second:${chat.conversationId}`,
      trigger: { kind: "manual", startedByUserId: "usr_test" },
    });
    assert.equal(second, null);
    assert.equal((await runsOf(chat.conversationId)).length, 1);
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
  it("asks for a location, re-asks on text, saves the shared pin and uses its parts", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["pickup"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    def.nodes = [
      {
        id: "where",
        type: "ask_location",
        version: 1,
        config: {
          text: "Where should we pick you up, {{contact.first_name}}?",
          saveAs: "pickup",
          acceptTyped: false,
          retries: 1,
          retryText: "Please tap Send location.",
          timeoutMinutes: 60,
        },
      },
      {
        id: "ok",
        type: "add_note",
        version: 1,
        config: { text: "Pickup {{answers.pickup}} {{answers.pickup.map_link}}" },
      },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "where" },
      { id: "2", source: "where", sourceHandle: "next", target: "ok" },
      { id: "3", source: "where", sourceHandle: "invalid", target: "bye" },
      { id: "4", source: "where", sourceHandle: "no_reply", target: "bye" },
    ];
    await liveAutomation("pickup", def);
    const chat = await newChat();
    await customerSays(chat, "pickup");
    const [ask] = await until("the location request", async () => {
      const m = (await botMessages(chat.conversationId)).filter((x) => x.type === "interactive");
      return m.length ? m : null;
    });
    assert.deepEqual(
      {
        kind: (ask?.content as { kind?: string } | undefined)?.kind,
        body: (ask?.content as { body?: string } | undefined)?.body,
      },
      { kind: "location_request", body: "Where should we pick you up, Asha?" },
    );
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    // Typed instead of shared: asked again (accepting typed addresses is off).
    await customerSays(chat, "Near the mall");
    await until("the re-ask", async () => {
      const m = (await botMessages(chat.conversationId)).filter((x) => x.type === "interactive");
      return m.length === 2 ? m : null;
    });
    await customerSharesLocation(chat, {
      latitude: 25.08,
      longitude: 55.14,
      name: "Marina Mall",
      address: null,
    });
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.deepEqual((run.output as { path: string[] }).path, ["where:next", "ok:next"]);
    const note = (await botMessages(chat.conversationId)).find((m) => m.type === "note");
    assert.equal(
      (note?.content as { text?: string } | undefined)?.text,
      "Pickup Marina Mall https://www.google.com/maps?q=25.08,55.14",
    );
  });

  it("takes a typed address when the step accepts one, and sends a map pin", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["visit"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    def.nodes = [
      {
        id: "where",
        type: "ask_location",
        version: 1,
        config: { text: "Where are you?", saveAs: "home", acceptTyped: true, retries: 1, timeoutMinutes: 60 },
      },
      {
        id: "pin",
        type: "send_location",
        version: 1,
        config: { latitude: 25.0806, longitude: 55.1403, name: "Lumen Marina", address: "Dubai Marina" },
      },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "where" },
      { id: "2", source: "where", sourceHandle: "next", target: "pin" },
      { id: "3", source: "where", sourceHandle: "invalid", target: "bye" },
      { id: "4", source: "where", sourceHandle: "no_reply", target: "bye" },
    ];
    await liveAutomation("visit", def);
    const chat = await newChat();
    await customerSays(chat, "visit");
    await until("the run to wait", async () => (await runOf(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "12 Palm Street");
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.deepEqual(
      (run.output as { answers: Record<string, { address?: string }> }).answers.home?.address,
      "12 Palm Street",
    );
    const pin = (await botMessages(chat.conversationId)).find((m) => m.type === "location");
    assert.deepEqual(pin?.content, {
      type: "location",
      latitude: 25.0806,
      longitude: 55.1403,
      name: "Lumen Marina",
      address: "Dubai Marina",
      url: null,
      automationId: `${ids.automation}_visit`,
    });
  });

  it("sends a link button through a tracked link; the first real tap takes Tapped", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["book"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    def.nodes = [
      {
        id: "link",
        type: "send_link",
        version: 1,
        config: {
          text: "Pick a time, {{contact.first_name}}",
          buttonText: "Book now",
          url: "https://example.com/book?name={{contact.name}}",
          waitForTap: true,
          timeoutMinutes: 60,
        },
      },
      { id: "yes", type: "add_note", version: 1, config: { text: "Opened the booking page" } },
      { id: "no", type: "add_note", version: 1, config: { text: "Never opened it" } },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "link" },
      { id: "2", source: "link", sourceHandle: "tapped", target: "yes" },
      { id: "3", source: "link", sourceHandle: "not_tapped", target: "no" },
    ];
    await liveAutomation("book", def);
    const chat = await newChat();
    await customerSays(chat, "book");
    const [sent] = await until("the link button", async () => {
      const m = (await botMessages(chat.conversationId)).filter((x) => x.type === "interactive");
      return m.length ? m : null;
    });
    const content = sent?.content as {
      kind?: string;
      body?: string;
      button?: { text: string; url: string };
      linkUrl?: string;
    };
    assert.equal(content.kind, "cta_url");
    assert.equal(content.body, "Pick a time, Asha");
    assert.equal(content.linkUrl, "https://example.com/book?name=Asha%20Rao");
    const code = /\/l\/([\w-]+)$/.exec(content.button?.url ?? "")?.[1] ?? "";
    assert.ok(code.length >= 10, content.button?.url ?? "no link");
    const [link] = await db.select().from(schema.trackedLink).where(eq(schema.trackedLink.code, code));
    assert.equal(link?.messageId, sent?.id);
    assert.equal(link?.url, "https://example.com/book?name=Asha%20Rao");
    // Tapped (twice): forwards to the page both times, wakes the run once.
    assert.deepEqual(await tapLink(code), { url: "https://example.com/book?name=Asha%20Rao" });
    assert.deepEqual(await tapLink(code), { url: "https://example.com/book?name=Asha%20Rao" });
    assert.equal(await tapLink("nope"), null);
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.deepEqual((run.output as { path: string[] }).path, ["link:tapped", "yes:next"]);
    const [after] = await db.select().from(schema.trackedLink).where(eq(schema.trackedLink.code, code));
    assert.equal(after?.tapCount, 2);
  });

  it("takes Not tapped when nobody opens the link in time", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["menu"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    def.nodes = [
      {
        id: "link",
        type: "send_link",
        version: 1,
        config: {
          text: "Our menu",
          buttonText: "Open",
          url: "https://example.com/menu",
          waitForTap: true,
          timeoutMinutes: 5,
        },
      },
      { id: "no", type: "add_note", version: 1, config: { text: "Never opened it" } },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "link" },
      { id: "3", source: "link", sourceHandle: "not_tapped", target: "no" },
    ];
    await liveAutomation("menu", def);
    const chat = await newChat();
    await customerSays(chat, "menu");
    const waiting = await until("the run to wait for a tap", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "waiting" ? r : null;
    });
    await timeOutWait(waiting.id);
    const run = await until("the run to finish", async () => {
      const r = await runOf(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.deepEqual((run.output as { path: string[] }).path, ["link:not_tapped", "no:next"]);
  });

  it("works out the distance to a shared pin and branches on it; no pin takes its own way", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["howfar"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    const note = (id: string, text: string) => ({ id, type: "add_note", version: 1, config: { text } });
    def.nodes = [
      {
        id: "where",
        type: "ask_location",
        version: 1,
        config: { text: "Where are you?", saveAs: "spot", acceptTyped: true, retries: 1, timeoutMinutes: 60 },
      },
      {
        id: "dist",
        type: "utility",
        version: 1,
        config: {
          ...utilityDefaults("distance", "dist"),
          from: "answers.spot",
          to: {
            kind: "place",
            place: { name: "Burj Al Arab", address: "", latitude: 25.1412, longitude: 55.1853 },
          },
        },
      },
      {
        id: "split",
        type: "branch",
        version: 1,
        config: {
          paths: [
            {
              id: "near",
              name: "Near",
              match: "all",
              rules: [{ kind: "variable", name: "values.dist.km", op: "lt", value: "5" }],
            },
            {
              id: "mid",
              name: "Drive",
              match: "all",
              rules: [{ kind: "variable", name: "values.dist.km", op: "lt", value: "50" }],
            },
          ],
        },
      },
      note("near", "near {{values.dist}}"),
      note("mid", "drive {{values.dist}} ({{values.dist.km}})"),
      note("far", "far"),
      note("nopin", "no pin for {{answers.spot}}"),
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "where" },
      { id: "2", source: "where", sourceHandle: "next", target: "dist" },
      { id: "3", source: "where", sourceHandle: "invalid", target: "bye" },
      { id: "4", source: "where", sourceHandle: "no_reply", target: "bye" },
      { id: "5", source: "dist", sourceHandle: "next", target: "split" },
      { id: "6", source: "dist", sourceHandle: "failed", target: "nopin" },
      { id: "7", source: "split", sourceHandle: "path:near", target: "near" },
      { id: "8", source: "split", sourceHandle: "path:mid", target: "mid" },
      { id: "9", source: "split", sourceHandle: "else", target: "far" },
    ];
    await liveAutomation("howfar", def);
    const done = async (chat: { conversationId: string }) =>
      until("the run to finish", async () => {
        const r = await runOf(chat.conversationId);
        return r?.status === "completed" ? r : null;
      });
    const noteOf = async (chat: { conversationId: string }) =>
      ((await botMessages(chat.conversationId)).find((m) => m.type === "note")?.content as { text?: string })
        ?.text;

    // Dubai Mall is about 10.9 km away: the second path, since the first doesn't match.
    const a = await newChat();
    await customerSays(a, "howfar");
    await until("the run to wait", async () => (await runOf(a.conversationId))?.status === "waiting");
    await customerSharesLocation(a, {
      latitude: 25.1972,
      longitude: 55.2744,
      name: "Dubai Mall",
      address: null,
    });
    const runA = await done(a);
    assert.deepEqual((runA.output as { path: string[] }).path, [
      "where:next",
      "dist:next",
      "split:path:mid",
      "mid:next",
    ]);
    assert.equal(await noteOf(a), "drive 10.9 km (10.9)");

    // A typed address has no pin: "No pin shared".
    const b = await newChat();
    await customerSays(b, "howfar");
    await until("the run to wait", async () => (await runOf(b.conversationId))?.status === "waiting");
    await customerSays(b, "Marina Walk");
    const runB = await done(b);
    assert.deepEqual((runB.output as { path: string[] }).path, ["where:next", "dist:failed", "nopin:next"]);
    assert.equal(await noteOf(b), "no pin for Marina Walk");
  });

  it("calculates, makes a reference code once, and branches on an answered date", async () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["quote"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    const tz = "Asia/Kolkata";
    def.nodes = [
      {
        id: "qty",
        type: "ask_question",
        version: 1,
        config: {
          text: "How many?",
          answer: { type: "text", format: "number" },
          saveAs: "qty",
          retries: 1,
          timeoutMinutes: 60,
        },
      },
      {
        id: "calc",
        type: "utility",
        version: 1,
        config: {
          ...utilityDefaults("calculate", "total"),
          formula: "{{answers.qty}} * 250 + 50",
          decimals: 0,
          currency: "INR",
        },
      },
      {
        id: "ref",
        type: "utility",
        version: 1,
        config: { ...utilityDefaults("reference_code", "ref"), prefix: "BK-" },
      },
      {
        id: "when",
        type: "ask_question",
        version: 1,
        config: {
          text: "Which day?",
          answer: { type: "text", format: "date" },
          saveAs: "day",
          retries: 1,
          timeoutMinutes: 60,
        },
      },
      {
        id: "split",
        type: "branch",
        version: 1,
        config: {
          paths: [
            {
              id: "soon",
              name: "This week",
              match: "all",
              rules: [{ kind: "date", source: "answers.day", op: "in_next_days", days: 7, timezone: tz }],
            },
          ],
        },
      },
      { id: "soon", type: "add_note", version: 1, config: { text: "{{values.total}} {{values.ref}} soon" } },
      {
        id: "later",
        type: "add_note",
        version: 1,
        config: { text: "{{values.total}} {{values.ref}} later" },
      },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "qty" },
      { id: "2", source: "qty", sourceHandle: "next", target: "calc" },
      { id: "3", source: "qty", sourceHandle: "invalid", target: "bye" },
      { id: "4", source: "qty", sourceHandle: "no_reply", target: "bye" },
      { id: "5", source: "calc", sourceHandle: "next", target: "ref" },
      { id: "6", source: "ref", sourceHandle: "next", target: "when" },
      { id: "7", source: "when", sourceHandle: "next", target: "split" },
      { id: "8", source: "when", sourceHandle: "invalid", target: "bye" },
      { id: "9", source: "when", sourceHandle: "no_reply", target: "bye" },
      { id: "10", source: "split", sourceHandle: "path:soon", target: "soon" },
      { id: "11", source: "split", sourceHandle: "else", target: "later" },
    ];
    await liveAutomation("quote", def);
    const inDays = (n: number) => {
      const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz })
        .format(new Date())
        .split("-")
        .map(Number);
      const at = new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + n));
      return `${at.getUTCDate()}/${at.getUTCMonth() + 1}/${at.getUTCFullYear()}`;
    };
    for (const [days, expect] of [
      [2, "soon"],
      [20, "later"],
    ] as const) {
      const chat = await newChat();
      await customerSays(chat, "quote");
      await until("the first question", async () => (await runOf(chat.conversationId))?.status === "waiting");
      await customerSays(chat, "3");
      // The run has gone past the code and waits for the day (the second question).
      await until("the second question", async () => {
        const m = await botMessages(chat.conversationId);
        return m.length >= 2 && (await runOf(chat.conversationId))?.status === "waiting";
      });
      await customerSays(chat, inDays(days));
      const run = await until("the run to finish", async () => {
        const r = await runOf(chat.conversationId);
        return r?.status === "completed" ? r : null;
      });
      const values = (run.output as { values: Record<string, { text: string }> }).values;
      assert.equal(values.total?.text, "₹800");
      assert.match(values.ref?.text ?? "", /^BK-[2-9A-HJ-KM-NP-Z]{6}$/);
      const note = (await botMessages(chat.conversationId)).find((m) => m.type === "note");
      // The code worked out before the run waited is the same one used after it was replayed.
      assert.equal((note?.content as { text?: string })?.text, `₹800 ${values.ref?.text} ${expect}`);
    }
  });

  it("checks a Condition saved in the older format, then dates on contact fields and worked-out values", async () => {
    const tz = "Asia/Kolkata";
    const dayIn = (n: number) => {
      const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz })
        .format(new Date())
        .split("-")
        .map(Number);
      return new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + n));
    };
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["renew"],
      match: "exact",
    });
    def.rules = { ...def.rules, skipIfAssigned: false };
    const util = (
      id: string,
      fn: Parameters<typeof utilityDefaults>[0],
      name: string,
      cfg: Record<string, unknown>,
    ) => ({
      id,
      type: "utility",
      version: 1,
      config: { ...utilityDefaults(fn, name), ...cfg },
    });
    def.nodes = [
      {
        id: "city",
        type: "ask_question",
        version: 1,
        config: {
          text: "Which city?",
          answer: { type: "text", format: "any" },
          saveAs: "city",
          retries: 1,
          timeoutMinutes: 60,
        },
      },
      {
        id: "vip",
        type: "condition",
        version: 1,
        // The shape saved before this change: an answer by name, a tag, and the 24-hour window.
        config: {
          match: "all",
          rules: [
            { kind: "answer", name: "city", op: "is", value: "dubai" },
            { kind: "contact", rule: { field: "tags", op: "has_any", value: ["tag_vip"] } },
            { kind: "window_open" },
          ],
        },
      },
      util("phone", "lookup", "phone", {
        key: "{{answers.city}}",
        rows: [
          { key: "Dubai", value: "+971 4 123 4567" },
          { key: "Kochi", value: "+91 484 000 000" },
        ],
      }),
      util("next", "date_time", "next", {
        start: "contact.renewal",
        change: "add",
        amount: 1,
        unit: "days",
        timezone: tz,
      }),
      util("gap", "date_diff", "gap", { from: "today", to: "contact.renewal", timezone: tz }),
      util("shout", "change_text", "shout", { text: "{{contact.name}}", mode: "upper" }),
      util("digits", "find_in_text", "digits", { text: "call {{values.phone}}", find: "phone" }),
      {
        id: "when",
        type: "branch",
        version: 1,
        config: {
          paths: [
            {
              id: "tomorrow",
              name: "Tomorrow",
              match: "all",
              rules: [{ kind: "date", source: "values.next", op: "is_tomorrow", timezone: tz }],
            },
            {
              id: "soon",
              name: "Renewal soon",
              match: "all",
              rules: [
                { kind: "date", source: "contact.renewal", op: "in_next_days", days: 5, timezone: tz },
                { kind: "date", source: "contact.added_on", op: "is_today", timezone: tz },
                { kind: "variable", name: "values.gap.days", op: "is_one_of", value: "1, 2, 3" },
              ],
            },
          ],
        },
      },
      {
        id: "soon",
        type: "add_note",
        version: 1,
        config: {
          text: "{{values.phone}} | {{values.next}} {{values.next.weekday}} | {{values.gap}} | {{values.shout}} | {{values.digits}}",
        },
      },
      { id: "no", type: "add_note", version: 1, config: { text: "not vip" } },
      { id: "other", type: "add_note", version: 1, config: { text: "other path" } },
      { id: "bye", type: "end", version: 1, config: {} },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "city" },
      { id: "2", source: "city", sourceHandle: "next", target: "vip" },
      { id: "3", source: "city", sourceHandle: "invalid", target: "bye" },
      { id: "4", source: "city", sourceHandle: "no_reply", target: "bye" },
      { id: "5", source: "vip", sourceHandle: "yes", target: "phone" },
      { id: "6", source: "vip", sourceHandle: "no", target: "no" },
      { id: "7", source: "phone", sourceHandle: "next", target: "next" },
      { id: "8", source: "phone", sourceHandle: "failed", target: "other" },
      { id: "9", source: "next", sourceHandle: "next", target: "gap" },
      { id: "10", source: "gap", sourceHandle: "next", target: "shout" },
      { id: "11", source: "shout", sourceHandle: "next", target: "digits" },
      { id: "12", source: "digits", sourceHandle: "next", target: "when" },
      { id: "13", source: "when", sourceHandle: "path:soon", target: "soon" },
      { id: "14", source: "when", sourceHandle: "path:tomorrow", target: "other" },
      { id: "15", source: "when", sourceHandle: "else", target: "other" },
    ];
    await liveAutomation("renew", def);
    const renewal = dayIn(2);
    const run = async (tagged: boolean, city: string) => {
      const chat = await newChat();
      await db
        .update(schema.contact)
        .set({ tagIds: tagged ? ["tag_vip"] : [], attributes: { renewal: iso(renewal) } })
        .where(eq(schema.contact.id, chat.contactId));
      await customerSays(chat, "renew");
      await until("the question", async () => (await runOf(chat.conversationId))?.status === "waiting");
      await customerSays(chat, city);
      const r = await until("the run to finish", async () => {
        const x = await runOf(chat.conversationId);
        return x?.status === "completed" ? x : null;
      });
      const note = (await botMessages(chat.conversationId)).find((m) => m.type === "note");
      return {
        path: (r.output as { path: string[] }).path,
        note: (note?.content as { text?: string })?.text,
      };
    };

    const yes = await run(true, " DUBAI ");
    assert.deepEqual(yes.path, [
      "city:next",
      "vip:yes",
      "phone:next",
      "next:next",
      "gap:next",
      "shout:next",
      "digits:next",
      "when:path:soon",
      "soon:next",
    ]);
    const next = dayIn(3);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(next);
    const short = `${weekday.slice(0, 3)}, ${next.getUTCDate()} ${new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(next)} ${next.getUTCFullYear()}`;
    assert.equal(yes.note, `+971 4 123 4567 | ${short} ${weekday} | 2 days | ASHA RAO | +97141234567`);

    // No tag: the Condition goes "No".
    const no = await run(false, "Dubai");
    assert.deepEqual(no.path, ["city:next", "vip:no", "no:next"]);
  });
});
