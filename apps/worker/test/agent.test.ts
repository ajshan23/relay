import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type ModelCaller, type ModelRequest, type ModelResponse, toolNames } from "@relay/agent";
import { agentWorkflow } from "@relay/core/agents";
import { emptyDefinition, type InboundEventPayload } from "@relay/core/automations";
import { createDb, eq, schema, sql } from "@relay/db";
import { createAutomations } from "../src/automations/runtime";

/*
 * The AI agent end to end on the local drill database, with a scripted model (no AI provider is
 * called) and a fake outbox (nothing is sent): an unclaimed chat is answered from the knowledge base,
 * quick messages make one answer, choices go out as buttons and a tap is read, hand-over leaves a note
 * and frees the chat, STOP stops it, credits running out hands over, an automation can hand a chat to
 * it, and a closed reply window sends nothing.
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const queued: string[] = [];
const outbox = { add: async (_: string, d: { messageId: string }) => queued.push(d.messageId) };
const T = `a${Date.now().toString(36)}`;
const ids = {
  org: `org_${T}`,
  branch: `br_${T}`,
  channel: `ch_${T}`,
  agent: `agt_${T}`,
  automation: `aut_${T}`,
  version: `autv_${T}`,
};

/** What each model call was sent, for checks. */
const calls: ModelRequest[] = [];
type Msg = { role: string; content: unknown };
const lastCustomerTexts = (messages: unknown[]) => {
  const out: string[] = [];
  const list = messages as Msg[];
  // Everything the customer said since the agent last spoke (the turn's gathered messages).
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] as Msg;
    if (m.role === "system") continue;
    if (m.role !== "user") break;
    out.unshift(String(m.content));
  }
  return out;
};
const r = (partial: Partial<ModelResponse>): ModelResponse => ({
  text: "",
  toolCalls: [],
  usage: { inputTokens: 400, cachedTokens: 0, outputTokens: 30 },
  model: "gpt-5.4-mini",
  latencyMs: 5,
  messages: [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "x", input: {} }] },
  ],
  ...partial,
});
/** A pretend model that reacts to what the customer said. */
const brain: ModelCaller = async (req) => {
  calls.push(req);
  const msgs = req.messages as Msg[];
  const toolMsg =
    msgs.at(-1)?.role === "tool"
      ? (msgs.at(-1) as { content: { output: { value: { data?: { results?: { text: string }[] } } } }[] })
      : null;
  if (toolMsg) {
    const hit = toolMsg.content[0]?.output.value.data?.results?.[0]?.text;
    return r({ text: hit ? `From what I know: ${hit}` : "I'm not sure." });
  }
  const said = lastCustomerTexts(msgs);
  const text = said.join(" ").toLowerCase();
  if (text.includes("timing"))
    return r({ toolCalls: [{ id: "s1", name: toolNames.search, input: { query: "timings" } }] });
  if (text.includes("person"))
    return r({
      toolCalls: [
        {
          id: "h1",
          name: toolNames.handoff,
          input: { reason: "Asked for a person", summary: "Wants to talk to someone." },
        },
      ],
    });
  if (text.includes("branch"))
    return r({
      toolCalls: [
        {
          id: "o1",
          name: toolNames.options,
          input: { text: "Which branch?", options: ["Kochi", "Dubai Marina"] },
        },
      ],
    });
  if (text.includes("root canal"))
    return r({
      toolCalls: [
        {
          id: "g1",
          name: toolNames.cantAnswer,
          input: { question: "Root canal treatment?", text: "Let me check that with the team." },
        },
      ],
    });
  if (text.includes("bye"))
    return r({
      toolCalls: [{ id: "c1", name: toolNames.close, input: { reason: "done", text: "Take care!" } }],
    });
  return r({ text: `You said: ${said.join(" / ")}` });
};

const automations = createAutomations({
  db,
  redis: { publish: async () => 0 },
  outbox: outbox as never,
  outboxJobOptions: {},
  databaseUrl: URL,
  listenUrl: URL,
  canType: () => false,
  ai: { callModel: brain, embed: null },
});
const worker = automations.worker();

let seq = 0;
async function newChat(windowOpen = true) {
  seq++;
  const contactId = `ct_${T}_${seq}`;
  const identityId = `cid_${T}_${seq}`;
  const conversationId = `conv_${T}_${seq}`;
  await db.insert(schema.contact).values({
    id: contactId,
    organizationId: ids.org,
    branchId: ids.branch,
    name: "Asha",
    phone: `97150${seq}`,
  });
  await db.insert(schema.contactIdentity).values({
    id: identityId,
    organizationId: ids.org,
    contactId,
    branchId: ids.branch,
    channelType: "whatsapp",
    scope: "waba",
    externalId: `97150${seq}`,
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
    windowExpiresAt: windowOpen ? new Date(Date.now() + 86_400_000) : new Date(Date.now() - 1000),
  });
  return { contactId, conversationId };
}

let msgSeq = 0;
async function customerSays(
  chat: { contactId: string; conversationId: string },
  text: string,
  reply: { id: string; title: string } | null = null,
) {
  const messageId = `msg_${T}_${++msgSeq}`;
  await db.transaction(async (tx) => {
    await tx.insert(schema.message).values({
      id: messageId,
      organizationId: ids.org,
      conversationId: chat.conversationId,
      channelAccountId: ids.channel,
      direction: "inbound",
      senderType: "contact",
      type: reply ? "interactive" : "text",
      content: reply
        ? { type: "interactive", kind: "button_reply", id: reply.id, title: reply.title }
        : { type: "text", text },
      status: "received",
      sentAt: new Date(),
    });
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
}

const agentMessages = (conversationId: string) =>
  db
    .select()
    .from(schema.message)
    .where(
      sql`${schema.message.conversationId} = ${conversationId} and ${schema.message.senderType} = 'ai_agent'`,
    )
    .orderBy(schema.message.createdAt);
const chatRow = async (conversationId: string) =>
  (await db.select().from(schema.conversation).where(eq(schema.conversation.id, conversationId)))[0];
const agentRun = async (conversationId: string) =>
  (
    await automations.kairos.listRuns({ workflow: agentWorkflow.name, labels: { conversationId }, limit: 1 })
  )[0] ?? null;

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
const textOf = (m: { content: unknown }) => {
  const c = m.content as { text?: string; body?: string };
  return c.text ?? c.body ?? "";
};

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: ids.org, name: "Lumen Agent Test", slug: `lumen-${T}`, createdAt: new Date() });
  await db.insert(schema.branch).values({
    id: ids.branch,
    organizationId: ids.org,
    name: "Marina",
    slug: `marina-${T}`,
    timezone: "Asia/Dubai",
  });
  await db.insert(schema.channelAccount).values({
    id: ids.channel,
    organizationId: ids.org,
    type: "whatsapp",
    provider: "meta",
    externalId: `pn_${T}`,
    displayName: "Lumen agent test",
    credentials: "test",
    status: "active",
    defaultBranchId: ids.branch,
  });
  await db.insert(schema.aiAgent).values({
    id: ids.agent,
    organizationId: ids.org,
    branchId: ids.branch,
    name: "Mira",
    role: "front desk",
    instructions: "Help with timings.",
    handoff: { when: "", assignToUserId: null, message: "Passing you to the team." },
    answerUnclaimed: true,
    status: "live",
  });
  await db.insert(schema.knowledgeSource).values({
    id: `ks_${T}`,
    organizationId: ids.org,
    branchId: ids.branch,
    kind: "text",
    title: "Timings",
    body: "Open 9am to 7pm.",
    status: "ready",
    chunkCount: 1,
  });
  await db.insert(schema.knowledgeChunk).values({
    id: `kc_${T}`,
    sourceId: `ks_${T}`,
    organizationId: ids.org,
    branchId: ids.branch,
    position: 0,
    content: "We are open 9am to 7pm, Monday to Saturday (timings).",
    tokens: 12,
  });
  // An automation on "ai" that hands the chat to the agent with a greeting.
  const def = emptyDefinition({
    type: "message_received",
    mode: "keyword",
    keywords: ["ai"],
    match: "exact",
  });
  def.rules = { ...def.rules, skipIfAssigned: false };
  def.nodes = [
    {
      id: "hand",
      type: "hand_to_ai",
      version: 1,
      config: { agentId: ids.agent, greeting: "Hi, Mira here! Ask me anything." },
    },
  ];
  def.edges = [{ id: "e1", source: "trigger", sourceHandle: "next", target: "hand" }];
  await db.insert(schema.automation).values({
    id: ids.automation,
    organizationId: ids.org,
    branchId: ids.branch,
    name: "Hand to Mira",
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

describe("AI agent in chats", () => {
  it("answers an unclaimed chat from its knowledge and records usage", async () => {
    const chat = await newChat();
    await customerSays(chat, "What are your timings?");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.match(textOf(reply as never), /From what I know: We are open 9am to 7pm/);
    assert.ok(queued.includes(reply?.id ?? ""));
    const conv = await chatRow(chat.conversationId);
    assert.equal(conv?.aiAgentId, ids.agent, "the agent holds the chat");
    assert.ok(conv?.automationRunId);
    // The prompt: stable system text, the customer's words, then the context note with the branch's time.
    const req = calls.find((c) => (c.messages as Msg[]).some((m) => String(m.content).includes("timings?")));
    assert.match(req?.system ?? "", /You are Mira, front desk at Lumen Agent Test/);
    const sent = (req?.messages ?? []) as Msg[];
    assert.match(String(sent.at(-1)?.content), /Asia\/Dubai.*Asha/s);
    const usage = await until("usage rows", async () => {
      const rows = await db
        .select()
        .from(schema.aiUsage)
        .where(eq(schema.aiUsage.conversationId, chat.conversationId));
      return rows.length === 2 ? rows : null;
    });
    assert.deepEqual(usage.map((u) => u.credits).sort(), [0, 1], "one credit for the turn, not per call");
    assert.ok(usage.every((u) => u.costMicros > 0));
  });

  it("makes one answer from several quick messages and keeps going", async () => {
    const chat = await newChat();
    const before = calls.length;
    await customerSays(chat, "hello");
    await customerSays(chat, "there");
    await customerSays(chat, "friend");
    const [first] = await until("one answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.equal(textOf(first as never), "You said: hello / there / friend");
    assert.equal(calls.length - before, 1, "one model call for three messages");
    await until(
      "waiting for the next message",
      async () => (await agentRun(chat.conversationId))?.status === "waiting",
    );
    await customerSays(chat, "and now?");
    await until("the second answer", async () => (await agentMessages(chat.conversationId)).length === 2);
    assert.equal(textOf((await agentMessages(chat.conversationId))[1] as never), "You said: and now?");
  });

  it("offers choices as buttons and reads the tap", async () => {
    const chat = await newChat();
    await customerSays(chat, "which branch is nearest?");
    const [q] = await until("the choices", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    const content = q?.content as { kind: string; body: string; options: { id: string; title: string }[] };
    assert.equal(content.kind, "buttons");
    assert.deepEqual(
      content.options.map((o) => o.title),
      ["Kochi", "Dubai Marina"],
    );
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "Kochi", { id: content.options[0]?.id ?? "", title: "Kochi" });
    await until("the answer to the tap", async () => (await agentMessages(chat.conversationId)).length === 2);
    assert.equal(textOf((await agentMessages(chat.conversationId))[1] as never), "You said: Kochi");
  });

  it("hands over with a note, frees the chat, and doesn't take it back the same day", async () => {
    const chat = await newChat();
    await customerSays(chat, "I want a person please");
    const run = await until("the run to end", async () => {
      const r = await agentRun(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.equal((run.output as { ended: string }).ended, "handoff");
    const msgs = await agentMessages(chat.conversationId);
    assert.deepEqual(
      msgs.map((m) => m.type),
      ["text", "note"],
    );
    assert.equal(textOf(msgs[0] as never), "Passing you to the team.");
    assert.match(textOf(msgs[1] as never), /Mira handed this chat over: Asked for a person/);
    const conv = await chatRow(chat.conversationId);
    assert.equal(conv?.automationRunId, null);
    assert.equal(conv?.aiAgentId, null);
    await customerSays(chat, "hello?");
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal((await agentMessages(chat.conversationId)).length, 2, "no new answer after a hand-over");
  });

  it("keeps a question it couldn't answer for Improve", async () => {
    const chat = await newChat();
    await customerSays(chat, "do you do root canal?");
    const gap = await until("the question kept", async () => {
      const rows = await db
        .select()
        .from(schema.aiGap)
        .where(eq(schema.aiGap.conversationId, chat.conversationId));
      return rows[0];
    });
    assert.equal(gap.question, "Root canal treatment?");
    assert.equal(
      textOf((await agentMessages(chat.conversationId))[0] as never),
      "Let me check that with the team.",
    );
  });

  it("closes the chat when the customer is done", async () => {
    const chat = await newChat();
    await customerSays(chat, "ok bye");
    await until("closed", async () => (await chatRow(chat.conversationId))?.status === "closed");
    assert.equal(textOf((await agentMessages(chat.conversationId))[0] as never), "Take care!");
    assert.equal((await chatRow(chat.conversationId))?.aiAgentId, null);
  });

  it("stops on STOP", async () => {
    const chat = await newChat();
    await customerSays(chat, "hi");
    await until("the first answer", async () => (await agentMessages(chat.conversationId)).length === 1);
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "STOP");
    // Either the run sees STOP itself (ends) or the router cancels it first: both free the chat.
    await until("stopped", async () => {
      const r = await agentRun(chat.conversationId);
      return r && ["completed", "cancelled"].includes(r.status);
    });
    await until("the chat freed", async () => (await chatRow(chat.conversationId))?.automationRunId === null);
    assert.equal((await agentMessages(chat.conversationId)).length, 1, "no answer to STOP");
  });

  it("takes over from an automation's Hand to AI agent step", async () => {
    const chat = await newChat();
    await customerSays(chat, "ai");
    const [greeting] = await until("the greeting", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.equal(textOf(greeting as never), "Hi, Mira here! Ask me anything.");
    assert.equal((await chatRow(chat.conversationId))?.aiAgentId, ids.agent);
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "cool");
    await until("the answer", async () => (await agentMessages(chat.conversationId)).length === 2);
    assert.equal(textOf((await agentMessages(chat.conversationId))[1] as never), "You said: cool");
  });

  it("sends nothing when the reply window is closed", async () => {
    const chat = await newChat(false);
    await customerSays(chat, "hello late");
    const run = await until("the run to end", async () => {
      const r = await agentRun(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.equal((run.output as { ended: string }).ended, "send_failed");
    assert.equal((await agentMessages(chat.conversationId)).length, 0);
  });

  it("hands over when the month's credits are used up", async () => {
    await db.insert(schema.aiCreditAllowance).values({ organizationId: ids.org, monthlyCredits: 1 });
    const chat = await newChat();
    await customerSays(chat, "hello once more");
    const run = await until("the run to end", async () => {
      const r = await agentRun(chat.conversationId);
      return r?.status === "completed" ? r : null;
    });
    assert.equal((run.output as { ended: string }).ended, "handoff");
    const note = (await agentMessages(chat.conversationId)).find((m) => m.type === "note");
    assert.match(textOf(note as never), /credits are used up/);
    await db.delete(schema.aiCreditAllowance).where(eq(schema.aiCreditAllowance.organizationId, ids.org));
  });
});
