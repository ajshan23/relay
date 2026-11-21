import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  catalogToolNames,
  type ModelCaller,
  type ModelRequest,
  type ModelResponse,
  toolNames,
} from "@relay/agent";
import { encryptSecret, newId } from "@relay/core";
import { httpToolConfigSchema } from "@relay/core/agent-tools";
import { agentWorkflow } from "@relay/core/agents";
import { emptyDefinition, type InboundEventPayload } from "@relay/core/automations";
import { defaultBookingSettings, localTime } from "@relay/core/bookings";
import {
  createCatalogType,
  createDb,
  eq,
  saveBookingSettings,
  saveCatalogItem,
  schema,
  sql,
} from "@relay/db";
import sharp from "sharp";
import { z } from "zod";
import { createFakeGoogle } from "../../../packages/core/test/fake-google";
import { createPhotoReader } from "../src/agent/photos";
import { createVoiceListener } from "../src/agent/voice";
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

/** The seeded catalogue's item ids, for the pretend model. */
const catalog = { sofa: `cti_s${T}`, table: `cti_t${T}`, haircut: "" };
/** The service the pretend model books (a haircut, or an online consultation). */
let bookingService = "";
/** A pretend Google for the online-booking test (connected to the branch only in that test). */
const google = createFakeGoogle();
const calendarKey = randomBytes(32).toString("base64");
/** Tomorrow in the branch's timezone, for bookings. */
const tomorrow = localTime(new Date(Date.now() + 86_400_000), "Asia/Dubai").date;

/** Stored voice notes by key, what each one "says" (by size), and the models used to hear them. */
const voiceFiles = new Map<string, Uint8Array>();
const spoken = new Map<number, string>();
const heardWith: string[] = [];
/** Each reply the pretend voice spoke, and in which language. */
const spokenBy: { text: string; language: string }[] = [];
/** Each photo the pretend vision model was shown: which model and how closely. */
const looks: { model: string; detail: string }[] = [];

/** The business's own system: a shop with orders, table bookings and (over MCP) stock. */
const toolKey = randomBytes(32).toString("base64");
const shop = {
  url: "",
  requests: [] as { method: string; path: string; key: string | undefined; body: unknown }[],
  bookings: 0,
};
let shopServer: Server;

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
/** "think slowly" makes the pretend model take a while, and says when it started (to write meanwhile). */
let slowStarted: () => void = () => {};
/** A pretend model that reacts to what the customer said. */
const brain: ModelCaller = async (req) => {
  calls.push(req);
  if (lastCustomerTexts(req.messages).join(" ").includes("think slowly")) {
    slowStarted();
    await new Promise((res) => setTimeout(res, 2500));
  }
  const msgs = req.messages as Msg[];
  const toolMsg =
    msgs.at(-1)?.role === "tool"
      ? (msgs.at(-1) as { content: { output: { value: { data?: { results?: { text: string }[] } } } }[] })
      : null;
  if (toolMsg) {
    const value = toolMsg.content[0]?.output.value as {
      data?: { results?: { text: string }[] };
      error?: string;
    };
    if (value.error) return r({ text: `Sorry, that didn't work: ${value.error}` });
    const times = (value.data as { times?: { label: string }[] } | undefined)?.times;
    if (times?.length)
      return r({
        toolCalls: [
          {
            id: "o2",
            name: toolNames.options,
            input: { text: "Which time suits you?", options: times.slice(0, 3).map((t) => t.label) },
          },
        ],
      });
    if (value.data && !("results" in value.data)) return r({ text: `Result: ${JSON.stringify(value.data)}` });
    const hit = value.data?.results?.[0]?.text;
    return r({ text: hit ? `From what I know: ${hit}` : "I'm not sure." });
  }
  // What a Yes / No tap led to arrives as a note after the chat.
  const act = msgs.at(-1)?.role === "system" ? String(msgs.at(-1)?.content) : "";
  if (act.startsWith("The customer tapped"))
    return r({
      text: act.includes("carried out")
        ? `All booked! ${act.match(/"ref(?:erence)?":"(\w+)"/)?.[1] ?? ""} ${act.match(/"meetLink":"([^"]+)"/)?.[1] ?? ""}`.trim()
        : act.includes("tapped No")
          ? "No problem, I haven't booked it."
          : `Hmm: ${act}`,
    });
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
  if (text.includes("sofa"))
    return r({
      toolCalls: [
        {
          id: "c1",
          name: catalogToolNames.show,
          input: { itemIds: [catalog.sofa, catalog.table], text: "Two picks" },
        },
      ],
    });
  if (text.includes("where is order"))
    return r({
      toolCalls: [{ id: "t1", name: "order_status", input: { order: text.match(/order (\w+)/)?.[1] ?? "" } }],
    });
  if (text.includes("book a table"))
    return r({
      toolCalls: [
        { id: "t2", name: "book_table", input: { people: 2, confirmText: "Book a table for 2 at 8 pm?" } },
      ],
    });
  if (text.includes("book a haircut") || text.includes("book a consultation"))
    return r({
      toolCalls: [{ id: "b1", name: "find_times", input: { service: bookingService, date: tomorrow } }],
    });
  const picked = text.match(/(\d{1,2}):(\d{2}) (am|pm)/);
  if (picked) {
    const h = (Number(picked[1]) % 12) + (picked[3] === "pm" ? 12 : 0);
    const time = `${String(h).padStart(2, "0")}:${picked[2]}`;
    return r({
      toolCalls: [
        {
          id: "b2",
          name: "book_time",
          input: {
            service: bookingService,
            date: tomorrow,
            time,
            confirmText: `Book a haircut at ${time}?`,
          },
        },
      ],
    });
  }
  const invite = said.join(" ").match(/invite me to ([A-Z2-9]{6}): (\S+)/);
  if (invite)
    return r({
      toolCalls: [
        {
          id: "b3",
          name: "invite_to_booking",
          input: { reference: invite[1] ?? "", email: invite[2] ?? "" },
        },
      ],
    });
  if (text.includes("call me back"))
    return r({
      toolCalls: [
        {
          id: "f1",
          name: "add_follow_up_task",
          input: {
            title: "Call back Asha about pricing",
            details: "Wants a call after 5 pm.",
            due: "tomorrow",
          },
        },
      ],
    });
  if (text.includes("stock count"))
    return r({ toolCalls: [{ id: "t3", name: "shop__stock", input: { item: "S26" } }] });
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
  ai: {
    callModel: brain,
    embed: null,
    // Voice notes: files from memory and a pretend speech-to-text (nothing is called).
    hearVoiceNotes: createVoiceListener({
      db,
      redis: { publish: async () => 0 },
      storage: { get: async (key: string) => voiceFiles.get(key) ?? new Uint8Array() } as never,
      transcribe: async (audio, model) => {
        heardWith.push(model);
        return { text: spoken.get(audio.byteLength) ?? "", language: "en", seconds: null, model };
      },
    }),
    // Voice replies: a pretend voice and encoder (no Cartesia, no ffmpeg); files kept in memory.
    voiceReplies: {
      speak: async (text: string, language: string) => {
        spokenBy.push({ text, language });
        return { audio: new Uint8Array([7, 7, 7]), model: "sonic-3", characters: text.length };
      },
      storage: {
        put: async (key: string, bytes: Uint8Array) => {
          voiceFiles.set(key, bytes);
        },
        get: async (key: string) => voiceFiles.get(key) ?? new Uint8Array(),
        exists: async (key: string) => voiceFiles.has(key),
        delete: async () => {},
      } as never,
      encode: async (audio: Uint8Array) => ({
        bytes: new Uint8Array([...audio, spokenBy.length]),
        seconds: 4,
      }),
    },
    // Photos: a pretend vision model that numbers what it was shown.
    seePhotos: createPhotoReader({
      db,
      redis: { publish: async () => 0 },
      storage: { get: async (key: string) => voiceFiles.get(key) ?? new Uint8Array() } as never,
      describe: async (_jpeg, model, detail) => {
        looks.push({ model, detail });
        return {
          text: `Photo #${looks.length}`,
          model,
          usage: { inputTokens: 300, cachedTokens: 0, outputTokens: 10 },
          costMicros: 250,
        };
      },
    }),
    // Google Calendar: a pretend Google (only one test connects it).
    calendar: { google: google.config, secretKey: calendarKey, appUrl: "https://app.test" },
    // The business's own tools: real HTTP to a local fake shop (allowed here only).
    ownTools: { secretKey: toolKey, allowPrivate: true },
  },
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
  replyTo: string | null = null,
  /** WhatsApp sends carousel and template buttons as a "button" message with the id as payload. */
  asButton = false,
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
      type: reply ? (asButton ? "button" : "interactive") : "text",
      content: reply
        ? asButton
          ? { type: "button", text: reply.title, payload: reply.id }
          : { type: "interactive", kind: "button_reply", id: reply.id, title: reply.title }
        : { type: "text", text },
      status: "received",
      sentAt: new Date(),
      replyToMessageId: replyTo,
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

/** A WhatsApp voice note, already downloaded. `bytes` sets its length (no ffprobe on junk: ~2,000 bytes a second). */
async function customerSendsVoiceNote(
  chat: { contactId: string; conversationId: string },
  bytes: number,
  says: string,
) {
  const messageId = `msg_${T}_${++msgSeq}`;
  const fileId = `sf_${T}_${msgSeq}`;
  const key = `test/${fileId}`;
  voiceFiles.set(key, new Uint8Array(bytes));
  spoken.set(bytes, says);
  await db.insert(schema.storedFile).values({
    id: fileId,
    organizationId: ids.org,
    sha256: fileId,
    sizeBytes: bytes,
    mimeType: "audio/ogg",
    storageKey: key,
  });
  await db.transaction(async (tx) => {
    await tx.insert(schema.message).values({
      id: messageId,
      organizationId: ids.org,
      conversationId: chat.conversationId,
      channelAccountId: ids.channel,
      direction: "inbound",
      senderType: "contact",
      type: "audio",
      content: { type: "audio", voice: true, media: { mimeType: "audio/ogg" } },
      status: "received",
      sentAt: new Date(),
    });
    await tx.insert(schema.attachment).values({
      id: `att_${T}_${msgSeq}`,
      organizationId: ids.org,
      messageId,
      kind: "audio",
      mimeType: "audio/ogg",
      fileId,
      status: "stored",
    });
    const ev: InboundEventPayload = {
      messageId,
      organizationId: ids.org,
      branchId: ids.branch,
      channelAccountId: ids.channel,
      conversationId: chat.conversationId,
      contactId: chat.contactId,
      type: "audio",
      text: "",
      reply: null,
      adId: null,
      optOut: null,
    };
    await automations.onInbound(tx as never, ev);
  });
  return messageId;
}

/** A WhatsApp photo, already downloaded (a real small PNG, so it can be shrunk). */
async function customerSendsPhoto(chat: { contactId: string; conversationId: string }, caption?: string) {
  const messageId = `msg_${T}_${++msgSeq}`;
  const fileId = `sf_${T}_${msgSeq}`;
  const key = `test/${fileId}`;
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#123456" } })
    .png()
    .toBuffer();
  voiceFiles.set(key, new Uint8Array(png));
  await db.insert(schema.storedFile).values({
    id: fileId,
    organizationId: ids.org,
    sha256: fileId,
    sizeBytes: png.byteLength,
    mimeType: "image/png",
    storageKey: key,
  });
  await db.transaction(async (tx) => {
    await tx.insert(schema.message).values({
      id: messageId,
      organizationId: ids.org,
      conversationId: chat.conversationId,
      channelAccountId: ids.channel,
      direction: "inbound",
      senderType: "contact",
      type: "image",
      content: { type: "image", media: { mimeType: "image/png", ...(caption ? { caption } : {}) } },
      status: "received",
      sentAt: new Date(),
    });
    await tx.insert(schema.attachment).values({
      id: `att_${T}_${msgSeq}`,
      organizationId: ids.org,
      messageId,
      kind: "image",
      mimeType: "image/png",
      fileId,
      status: "stored",
    });
    const ev: InboundEventPayload = {
      messageId,
      organizationId: ids.org,
      branchId: ids.branch,
      channelAccountId: ids.channel,
      conversationId: chat.conversationId,
      contactId: chat.contactId,
      type: "image",
      text: caption ?? "",
      reply: null,
      adId: null,
      optOut: null,
    };
    await automations.onInbound(tx as never, ev);
  });
  return messageId;
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
    branchId: ids.branch,
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
  // An automation on "start bot" that answers itself, then hands to the agent with no greeting.
  const def2 = emptyDefinition({
    type: "message_received",
    mode: "keyword",
    keywords: ["start bot"],
    match: "exact",
  });
  def2.rules = { ...def2.rules, skipIfAssigned: false };
  def2.nodes = [
    { id: "hi", type: "send_message", version: 1, config: { text: "Hi there", media: null } },
    { id: "hand", type: "hand_to_ai", version: 1, config: { agentId: ids.agent, greeting: "" } },
  ];
  def2.edges = [
    { id: "e1", source: "trigger", sourceHandle: "next", target: "hi" },
    { id: "e2", source: "hi", sourceHandle: "next", target: "hand" },
  ];
  await db.insert(schema.automation).values({
    id: `${ids.automation}b`,
    organizationId: ids.org,
    branchId: ids.branch,
    name: "Hi, then Mira",
    channelAccountId: ids.channel,
    status: "live",
    draft: def2,
    liveVersionId: `${ids.version}b`,
    triggerType: "message_received",
  });
  await db.insert(schema.automationVersion).values({
    id: `${ids.version}b`,
    automationId: `${ids.automation}b`,
    organizationId: ids.org,
    number: 1,
    definition: def2,
    checksum: "test",
  });
  // A small catalogue: a sofa with two photos and a table with one.
  await db
    .insert(schema.organizationSettings)
    .values({ organizationId: ids.org, catalog: { currency: "AED" } });
  const type = await createCatalogType(db, {
    organizationId: ids.org,
    name: "Furniture",
    kind: "product",
    template: "product",
    newId: (k) => newId(k),
  });
  for (const [key, title, price] of [
    ["sofa", "Sofa Oslo", 1800],
    ["table", "Oak table", 900],
  ] as const) {
    const item = await saveCatalogItem(db, {
      organizationId: ids.org,
      branchId: ids.branch,
      userId: null,
      input: {
        typeId: type.id,
        title,
        description: "",
        attributes: {},
        status: "active",
        tags: [],
        variants: [{ title: "", price, currency: "AED", options: {}, available: true, bookable: false }],
      },
      newId: (k) => newId(k),
    });
    catalog[key] = item.id;
  }
  // A haircut that can be booked, and the branch taking bookings every day 09:00–18:00.
  const services = await createCatalogType(db, {
    organizationId: ids.org,
    name: "Services",
    kind: "service",
    template: "service",
    newId: (k) => newId(k),
  });
  const haircut = await saveCatalogItem(db, {
    organizationId: ids.org,
    branchId: ids.branch,
    userId: null,
    input: {
      typeId: services.id,
      title: "Haircut",
      description: "",
      attributes: {},
      status: "active",
      tags: [],
      variants: [
        {
          title: "",
          price: 60,
          currency: "AED",
          options: {},
          available: true,
          bookable: true,
          durationMinutes: 30,
        },
      ],
    },
    newId: (k) => newId(k),
  });
  catalog.haircut = haircut.id;
  await saveBookingSettings(db, ids.org, ids.branch, {
    ...defaultBookingSettings,
    enabled: true,
    hours: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, from: "09:00", to: "18:00" })),
    minNoticeMinutes: 0,
  });
  for (const [itemId, n, primary] of [
    [catalog.sofa, 1, true],
    [catalog.sofa, 2, false],
    [catalog.table, 3, true],
  ] as const) {
    const fileId = `sf_c${T}_${n}`;
    await db.insert(schema.storedFile).values({
      id: fileId,
      organizationId: ids.org,
      sha256: `${T}${n}`.padEnd(64, "0"),
      sizeBytes: 10,
      mimeType: "image/jpeg",
      storageKey: `files/x/${n}`,
    });
    await db.insert(schema.catalogMedia).values({
      id: `ctm_c${T}_${n}`,
      organizationId: ids.org,
      branchId: ids.branch,
      itemId,
      fileId,
      kind: "image",
      status: "ready",
      isPrimary: primary,
      position: n,
    });
  }
  // The shop: GET /orders/:id (by the customer's phone), POST /bookings, and an MCP server with stock.
  shopServer = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (path.startsWith("/mcp")) {
      const mcp = new McpServer({ name: "shop", version: "1.0.0" });
      mcp.registerTool(
        "stock",
        {
          description: "Stock of an item",
          inputSchema: { item: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ item }) => ({ content: [{ type: "text", text: JSON.stringify({ item, left: 3 }) }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    shop.requests.push({
      method: req.method ?? "",
      path,
      key: req.headers["x-shop-key"] as string | undefined,
      body: raw ? JSON.parse(raw) : null,
    });
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (path.startsWith("/orders/boom")) return json(500, { error: "database down" });
    if (path.startsWith("/orders/")) {
      const phone = new globalThis.URL(path, "http://x").searchParams.get("phone");
      return json(200, {
        order: path.split("/")[2]?.split("?")[0],
        status: "out for delivery",
        phone,
        cost: 12,
      });
    }
    if (path === "/bookings" && req.method === "POST") {
      shop.bookings++;
      return json(201, { ref: `B${shop.bookings}` });
    }
    return json(404, { error: "not found" });
  });
  await new Promise<void>((done) => shopServer.listen(0, "127.0.0.1", done));
  shop.url = `http://127.0.0.1:${(shopServer.address() as AddressInfo).port}`;
  const tool = (id: string, values: Partial<typeof schema.aiTool.$inferInsert>) => ({
    id: `${id}${T}`,
    organizationId: ids.org,
    branchId: ids.branch,
    agentId: ids.agent,
    kind: "http" as const,
    name: id,
    title: id,
    description: "",
    config: httpToolConfigSchema.parse({ method: "GET", url: shop.url }),
    ...values,
  });
  await db.insert(schema.aiTool).values([
    tool("order_status", {
      title: "Order status",
      description: "When they ask where their order is",
      config: httpToolConfigSchema.parse({
        method: "GET",
        url: `${shop.url}/orders/{{input.order}}`,
        query: [{ key: "phone", value: "{{contact.phone}}" }],
        inputs: [{ key: "order", description: "The order number", type: "text", required: true }],
        pick: ["order", "status", "phone"],
      }),
      secret: encryptSecret({ header: "x-shop-key", value: "s3cret" }, toolKey),
      secretHint: "cret",
    }),
    tool("book_table", {
      title: "Book a table",
      description: "When they want a table",
      confirm: true,
      config: httpToolConfigSchema.parse({
        method: "POST",
        url: `${shop.url}/bookings`,
        body: '{"people":{{input.people}},"phone":"{{contact.phone}}","name":"{{contact.name}}"}',
        inputs: [{ key: "people", description: "How many", type: "number", required: true }],
      }),
    }),
    tool("switched_off", { title: "Switched off", enabled: false }),
    {
      ...tool("shop", { title: "Shop" }),
      kind: "mcp" as const,
      config: {
        url: `${shop.url}/mcp`,
        listedAt: null,
        tools: [
          {
            name: "stock",
            description: "Stock of an item",
            inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            readOnly: true,
            allowed: true,
            confirm: false,
          },
          {
            name: "delete_everything",
            description: "Not allowed",
            inputSchema: { type: "object" },
            readOnly: false,
            allowed: false,
            confirm: true,
          },
        ],
      },
    },
  ]);
  await automations.startWorker(worker);
});

after(async () => {
  shopServer?.close();
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

  it("hears a voice note, answers what was said and charges for the minutes", async () => {
    const chat = await newChat();
    const noteId = await customerSendsVoiceNote(chat, 20_000, "hello from a voice note");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.equal(textOf(reply as never), "You said: [voice note you listened to] hello from a voice note");
    assert.equal(heardWith.at(-1), "gpt-4o-mini-transcribe", "Accurate by default");
    const [note] = await db.select().from(schema.message).where(eq(schema.message.id, noteId));
    assert.equal(
      (note?.content as { transcript?: string } | undefined)?.transcript,
      "hello from a voice note",
    );
    const [heard] = await db
      .select()
      .from(schema.aiUsage)
      .where(
        sql`${schema.aiUsage.conversationId} = ${chat.conversationId} and ${schema.aiUsage.kind} = 'transcribe'`,
      );
    assert.equal(heard?.credits, 1, "10 seconds: one credit");
    assert.ok((heard?.costMicros ?? 0) > 0);

    // More accurate: the other model and twice the credits; over 3 minutes isn't heard at all.
    await db.update(schema.aiAgent).set({ voiceNotes: "best" }).where(eq(schema.aiAgent.id, ids.agent));
    try {
      await until(
        "waiting for the next message",
        async () => (await agentRun(chat.conversationId))?.status === "waiting",
      );
      await customerSendsVoiceNote(chat, 150_000, "a longer one");
      await until("the second answer", async () => (await agentMessages(chat.conversationId)).length === 2);
      assert.equal(heardWith.at(-1), "gpt-4o-transcribe");
      const credits = await db
        .select({ credits: schema.aiUsage.credits })
        .from(schema.aiUsage)
        .where(
          sql`${schema.aiUsage.conversationId} = ${chat.conversationId} and ${schema.aiUsage.kind} = 'transcribe'`,
        );
      assert.deepEqual(credits.map((c) => c.credits).sort(), [1, 4], "75 seconds, more accurate: 2 × 2");

      await until("waiting again", async () => (await agentRun(chat.conversationId))?.status === "waiting");
      const before = heardWith.length;
      await customerSendsVoiceNote(chat, 400_000, "far too long");
      const replies = await until("the third answer", async () => {
        const m = await agentMessages(chat.conversationId);
        return m.length === 3 ? m : null;
      });
      assert.equal(heardWith.length, before, "not sent to speech-to-text");
      assert.equal(textOf(replies[2] as never), "You said: [voice note, not heard: longer than 3 minutes]");
    } finally {
      await db.update(schema.aiAgent).set({ voiceNotes: "accurate" }).where(eq(schema.aiAgent.id, ids.agent));
    }
  });

  it("looks at a photo, answers what's in it, and charges per photo", async () => {
    const chat = await newChat();
    const before = looks.length;
    const photoId = await customerSendsPhoto(chat, "do you have this?");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    const n = before + 1;
    assert.equal(
      textOf(reply as never),
      `You said: [photo you looked at] Photo #${n} Caption: "do you have this?"`,
    );
    assert.deepEqual(looks.at(-1), { model: "gpt-5.4-mini", detail: "low" }, "Accurate by default");
    const [photo] = await db.select().from(schema.message).where(eq(schema.message.id, photoId));
    assert.equal((photo?.content as { description?: string } | undefined)?.description, `Photo #${n}`);
    const usage = () =>
      db
        .select({ credits: schema.aiUsage.credits })
        .from(schema.aiUsage)
        .where(
          sql`${schema.aiUsage.conversationId} = ${chat.conversationId} and ${schema.aiUsage.kind} = 'vision'`,
        );
    assert.deepEqual(
      (await usage()).map((u) => u.credits),
      [1],
    );

    // More accurate: high detail, 2 credits each; four at once means the oldest isn't looked at.
    await db.update(schema.aiAgent).set({ photos: "best" }).where(eq(schema.aiAgent.id, ids.agent));
    try {
      await until(
        "waiting for the next message",
        async () => (await agentRun(chat.conversationId))?.status === "waiting",
      );
      for (let i = 0; i < 4; i++) await customerSendsPhoto(chat);
      const replies = await until("the second answer", async () => {
        const m = await agentMessages(chat.conversationId);
        return m.length === 2 ? m : null;
      });
      assert.deepEqual(looks.at(-1), { model: "gpt-5.4-mini", detail: "high" });
      assert.deepEqual((await usage()).map((u) => u.credits).sort(), [1, 2, 2, 2]);
      assert.match(textOf(replies[1] as never), /\[photo, not looked at: too many photos at once\]/);
      assert.match(textOf(replies[1] as never), new RegExp(`Photo #${n + 3}`));
    } finally {
      await db.update(schema.aiAgent).set({ photos: "accurate" }).where(eq(schema.aiAgent.id, ids.agent));
    }
  });

  it("waits for the words after a bare photo, and makes one answer of both", async () => {
    const chat = await newChat();
    await customerSendsPhoto(chat);
    // Longer than the usual 3.5 s gap, within the 8 s allowed after a photo with no caption.
    await new Promise((res) => setTimeout(res, 5000));
    await customerSays(chat, "in black?");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.match(textOf(reply as never), /\[photo you looked at\] Photo #\d+ \/ in black\?$/);
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal((await agentMessages(chat.conversationId)).length, 1, "one answer, not two");
  });

  it("drops a draft when the customer writes again meanwhile, and answers everything together", async () => {
    const chat = await newChat();
    const started = new Promise<void>((res) => {
      slowStarted = res;
    });
    await customerSays(chat, "think slowly about phones");
    await started;
    await customerSays(chat, "and in blue?");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.equal(textOf(reply as never), "You said: think slowly about phones / and in blue?");
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal((await agentMessages(chat.conversationId)).length, 1, "the first draft never went out");
    slowStarted = () => {};
  });

  it("answers a voice note with a voice note, and text with text, when set to", async () => {
    await db
      .update(schema.aiAgent)
      .set({ voiceReplies: "voice_notes" })
      .where(eq(schema.aiAgent.id, ids.agent));
    try {
      const chat = await newChat();
      await customerSendsVoiceNote(chat, 21_000, "is the phone in stock");
      const [reply] = await until("the answer", async () => {
        const m = await agentMessages(chat.conversationId);
        return m.length ? m : null;
      });
      assert.equal(reply?.type, "audio");
      const content = reply?.content as { voice?: boolean; transcript?: string; transcriptSeconds?: number };
      assert.equal(content.voice, true, "sent as a WhatsApp voice note");
      assert.equal(content.transcript, "You said: [voice note you listened to] is the phone in stock");
      assert.equal(content.transcriptSeconds, 4);
      assert.deepEqual(spokenBy.at(-1), {
        text: "You said: [voice note you listened to] is the phone in stock",
        language: "en",
      });
      const [att] = await db
        .select()
        .from(schema.attachment)
        .where(eq(schema.attachment.messageId, reply?.id ?? ""));
      assert.equal(att?.mimeType, "audio/ogg");
      const speech = await db
        .select({ credits: schema.aiUsage.credits, model: schema.aiUsage.model })
        .from(schema.aiUsage)
        .where(
          sql`${schema.aiUsage.conversationId} = ${chat.conversationId} and ${schema.aiUsage.kind} = 'speech'`,
        );
      assert.deepEqual(speech, [{ credits: 1, model: "sonic-3" }]);

      // A typed message gets a typed answer; the agent remembers what it said out loud.
      await until(
        "waiting for the next message",
        async () => (await agentRun(chat.conversationId))?.status === "waiting",
      );
      const before = spokenBy.length;
      await customerSays(chat, "ok thanks");
      const replies = await until("the second answer", async () => {
        const m = await agentMessages(chat.conversationId);
        return m.length === 2 ? m : null;
      });
      assert.equal(replies[1]?.type, "text");
      assert.equal(spokenBy.length, before, "not spoken");
      const req = calls.at(-1);
      assert.ok(
        ((req?.messages ?? []) as Msg[]).some((m) =>
          String(m.content).includes("[voice note you sent] You said:"),
        ),
        "its own voice note is in its history as text",
      );
    } finally {
      await db.update(schema.aiAgent).set({ voiceReplies: "off" }).where(eq(schema.aiAgent.id, ids.agent));
    }
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

  it("steps back from a chat it's in when it is paused", async () => {
    const chat = await newChat();
    await customerSays(chat, "hello mira");
    await until("the first answer", async () => (await agentMessages(chat.conversationId)).length === 1);
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await db.update(schema.aiAgent).set({ status: "paused" }).where(eq(schema.aiAgent.id, ids.agent));
    try {
      await customerSays(chat, "are you there?");
      const run = await until("the run to end", async () => {
        const r = await agentRun(chat.conversationId);
        return r?.status === "completed" ? r : null;
      });
      assert.equal((run.output as { ended: string }).ended, "paused");
      const msgs = await agentMessages(chat.conversationId);
      assert.deepEqual(
        msgs.map((m) => m.type),
        ["text", "note"],
        "no reply after the pause, just a note for the team",
      );
      assert.equal((await chatRow(chat.conversationId))?.automationRunId, null);
      // While paused it doesn't take new chats either.
      const other = await newChat();
      await customerSays(other, "hi there");
      await new Promise((res) => setTimeout(res, 1500));
      assert.equal(await agentRun(other.conversationId), null);
    } finally {
      await db.update(schema.aiAgent).set({ status: "live" }).where(eq(schema.aiAgent.id, ids.agent));
    }
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

  it("doesn't answer again what an automation already answered before handing over", async () => {
    const chat = await newChat();
    await customerSays(chat, "start bot");
    await until("Mira in charge", async () => (await chatRow(chat.conversationId))?.aiAgentId === ids.agent);
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    assert.equal((await agentMessages(chat.conversationId)).length, 0, "no second greeting");
    await customerSays(chat, "prices?");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.equal(textOf(reply as never), "You said: prices?");
  });

  it("shows catalogue items as cards, sends the gallery on More details without the model, and names the item on Order", async () => {
    const chat = await newChat();
    await customerSays(chat, "do you have a sofa?");
    const [cards] = await until("the cards", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    const c = cards?.content as {
      kind: string;
      body: string;
      cards: { fileId: string; buttons: { id: string; title: string }[] }[];
      items: { id: string }[];
    };
    assert.equal(c.kind, "carousel", "both items have a photo");
    assert.equal(c.body, "Two picks");
    assert.deepEqual(
      c.items.map((i) => i.id),
      [catalog.sofa, catalog.table],
    );
    assert.deepEqual(
      c.cards[0]?.buttons.map((b) => b.title),
      ["More details", "Order"],
    );
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");

    const before = calls.length;
    const more = c.cards[0]?.buttons[0] as { id: string; title: string };
    await customerSays(chat, "More details", more, cards?.id ?? null);
    const gallery = await until("the gallery", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length > 1 ? m.slice(1) : null;
    });
    const g = gallery[0]?.content as {
      kind: string;
      body: string;
      cards: unknown[];
      items: { id: string }[];
    };
    assert.equal(g.kind, "carousel", "the sofa's two photos");
    assert.equal(g.cards.length, 2);
    assert.match(g.body, /\*Sofa Oslo\*\nAED 1,800/);
    assert.equal(calls.length, before, "no model call for More details");

    await until("waiting again", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    const order = c.cards[0]?.buttons[1] as { id: string; title: string };
    await customerSays(chat, "Order", order, cards?.id ?? null, true);
    await until("the answer", async () => calls.length > before);
    const said = lastCustomerTexts(calls.at(-1)?.messages ?? []).join(" ");
    assert.match(said, new RegExp(`tapped "Order" on Sofa Oslo \\(${catalog.sofa}\\)`));
    // The agent's prompt says it sells from a catalogue and has the tools for it.
    assert.match(calls.at(-1)?.system ?? "", /What the business sells/);
    assert.ok(calls.at(-1)?.tools.some((t) => t.name === catalogToolNames.search));
  });

  it("uses Teach changes from the next message, also in a chat already going", async () => {
    const chat = await newChat();
    await customerSays(chat, "hello there");
    await until("the first answer", async () => (await agentMessages(chat.conversationId)).length === 1);
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    const [before] = await db.select().from(schema.aiAgent).where(eq(schema.aiAgent.id, ids.agent));
    await db
      .update(schema.aiAgent)
      .set({ role: "sales assistant", instructions: "Sell laptops and phones." })
      .where(eq(schema.aiAgent.id, ids.agent));
    try {
      const n = calls.length;
      await customerSays(chat, "and now?");
      await until("the second answer", async () => calls.length > n);
      assert.match(calls.at(-1)?.system ?? "", /You are Mira, sales assistant/);
      assert.match(calls.at(-1)?.system ?? "", /Sell laptops and phones\./);
    } finally {
      await db
        .update(schema.aiAgent)
        .set({ role: before?.role ?? "", instructions: before?.instructions ?? "" })
        .where(eq(schema.aiAgent.id, ids.agent));
    }
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

describe("the business's own tools", () => {
  const toolCalls = (conversationId: string) =>
    db.select().from(schema.aiToolCall).where(eq(schema.aiToolCall.conversationId, conversationId));

  it("looks an order up in the business's system with the customer's phone, and logs the call", async () => {
    const chat = await newChat();
    await customerSays(chat, "where is order 1001?");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    const phone = `97150${seq}`;
    assert.equal(
      textOf(reply as never),
      `Result: {"order":"1001","status":"out for delivery","phone":"${phone}"}`,
      "only the ticked fields reach the agent (not cost)",
    );
    const sent = shop.requests.find((q) => q.path.startsWith("/orders/1001"));
    assert.equal(sent?.key, "s3cret", "the saved key is sent");
    const offered = calls.at(-2)?.tools.map((t) => t.name) ?? [];
    assert.ok(
      offered.includes("order_status") && offered.includes("book_table") && offered.includes("shop__stock"),
    );
    assert.ok(!offered.includes("switched_off") && !offered.includes("shop__delete_everything"));
    assert.match(calls.at(-2)?.system ?? "", /business's own tools/);
    const logged = await until("the call log", async () => {
      const rows = await toolCalls(chat.conversationId);
      return rows.length ? rows : null;
    });
    assert.deepEqual(
      logged.map((l) => [l.name, l.status, l.httpStatus, l.mode]),
      [["order_status", "ok", 200, "live"]],
    );
  });

  it("says plainly when the business's system fails", async () => {
    const chat = await newChat();
    await customerSays(chat, "where is order boom?");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.match(
      textOf(reply as never),
      /Sorry, that didn't work: Their system answered 500: \{"error":"database down"\}/,
    );
  });

  it("uses an allowed MCP tool", async () => {
    const chat = await newChat();
    await customerSays(chat, "stock count for the S26?");
    const [reply] = await until("the answer", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    assert.equal(textOf(reply as never), 'Result: {"item":"S26","left":3}');
  });

  it("asks before a change, does it once on Yes (even tapped twice), and not on No or late", async () => {
    const chat = await newChat();
    const before = shop.bookings;
    const ask = async (n: number) => {
      await customerSays(chat, "book a table for 2 please");
      const msgs = await until("the question", async () => {
        const m = await agentMessages(chat.conversationId);
        return m.length === n ? m : null;
      });
      await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
      const q = msgs.at(-1) as (typeof msgs)[number];
      const content = q.content as {
        body: string;
        options: { id: string; title: string }[];
        pendingAction: object;
      };
      return { q, content };
    };
    const tap = (q: { id: string }, content: { options: { id: string; title: string }[] }, i: number) =>
      customerSays(chat, content.options[i]?.title ?? "", content.options[i] ?? null, q.id);

    // Yes: booked once, with the customer's details filled in; a second tap does nothing more.
    const first = await ask(1);
    assert.equal(first.content.body, "Book a table for 2 at 8 pm?");
    assert.deepEqual(
      first.content.options.map((o) => o.title),
      ["Yes", "No"],
    );
    assert.equal(shop.bookings, before, "nothing booked before Yes");
    await tap(first.q, first.content, 0);
    await until("the confirmation", async () => (await agentMessages(chat.conversationId)).length === 2);
    assert.equal(
      textOf((await agentMessages(chat.conversationId))[1] as never),
      `All booked! B${before + 1}`,
    );
    assert.deepEqual(shop.requests.at(-1)?.body, { people: 2, phone: `97150${seq}`, name: "Asha" });
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await tap(first.q, first.content, 0);
    await until(
      "the answer to the second tap",
      async () => (await agentMessages(chat.conversationId)).length === 3,
    );
    assert.match(textOf((await agentMessages(chat.conversationId))[2] as never), /already answered/);
    assert.equal(shop.bookings, before + 1, "booked once");

    // No: nothing booked.
    const second = await ask(4);
    await tap(second.q, second.content, 1);
    await until("the answer to No", async () => (await agentMessages(chat.conversationId)).length === 5);
    assert.equal(
      textOf((await agentMessages(chat.conversationId))[4] as never),
      "No problem, I haven't booked it.",
    );

    // Too late: a Yes after the question expired does nothing.
    const third = await ask(6);
    await db
      .update(schema.message)
      .set({
        content: {
          ...third.content,
          pendingAction: { ...third.content.pendingAction, expiresAt: "2020-01-01T00:00:00Z" },
        },
      })
      .where(eq(schema.message.id, third.q.id));
    await tap(third.q, third.content, 0);
    await until(
      "the answer to a late Yes",
      async () => (await agentMessages(chat.conversationId)).length === 7,
    );
    assert.match(
      textOf((await agentMessages(chat.conversationId))[6] as never),
      /minutes after it was asked/,
    );
    assert.equal(shop.bookings, before + 1);

    const logged = (await toolCalls(chat.conversationId)).map((l) => [l.name, l.status]);
    assert.deepEqual(logged.sort(), [
      ["book_table", "declined"],
      ["book_table", "ok"],
    ]);
    // The agent's own history says what it asked and what was tapped.
    const history = (calls.at(-1)?.messages ?? []) as Msg[];
    assert.ok(history.some((m) => String(m.content).includes("they tapped Yes")));
  });
});

describe("bookings with Mira", () => {
  it("finds free times, books one after Yes, notes it for the team, and doesn't offer it again", async () => {
    bookingService = catalog.haircut;
    const chat = await newChat();
    await customerSays(chat, "Can I book a haircut tomorrow?");
    const [q] = await until("the times", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    const times = q?.content as { options: { id: string; title: string }[] };
    assert.equal(times.options.length, 3);
    assert.match(times.options[0]?.title ?? "", /, 9:00 am$/);
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, times.options[0]?.title ?? "", times.options[0] ?? null, q?.id ?? null);
    const asked = await until("the Yes / No question", async () => {
      const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
      return m.length === 2 ? m[1] : null;
    });
    const content = asked.content as { body: string; options: { id: string; title: string }[] };
    assert.equal(content.body, "Book a haircut at 09:00?");
    // Its history says which times it gave and that the tap was one of them.
    const seen = JSON.stringify(calls.at(-1)?.messages ?? []);
    assert.match(seen, /\[gave choices: [^\]]*9:00 am/);
    assert.match(seen, /\[picked \\"[^\\]*9:00 am\\" from the choices we gave\]/);
    const before = await db
      .select()
      .from(schema.booking)
      .where(eq(schema.booking.conversationId, chat.conversationId));
    assert.equal(before.length, 0, "nothing booked before Yes");
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "Yes", content.options[0] ?? null, asked?.id ?? null);
    const done = await until("the booking", async () => {
      const rows = await db
        .select()
        .from(schema.booking)
        .where(eq(schema.booking.conversationId, chat.conversationId));
      return rows.length ? rows : null;
    });
    assert.equal(done[0]?.bookedBy, "ai");
    assert.equal(done[0]?.contactId, chat.contactId);
    assert.equal(done[0]?.title, "Haircut");
    const reply = await until("the confirmation", async () => {
      const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
      return m.length === 3 ? m[2] : null;
    });
    assert.equal(textOf(reply as never), `All booked! ${done[0]?.reference}`);
    const note = (await agentMessages(chat.conversationId)).find((m) => m.type === "note");
    assert.match(textOf(note as never), /Mira booked Haircut for .*9:00 am\. Reference/);

    // Another customer asking for the same day isn't offered 9:00 any more.
    const other = await newChat();
    await customerSays(other, "book a haircut please");
    const [q2] = await until("the times", async () => {
      const m = await agentMessages(other.conversationId);
      return m.length ? m : null;
    });
    const offered = q2?.content as { options?: { title: string }[] } | undefined;
    assert.match(offered?.options?.[0]?.title ?? "", /, 9:30 am$/);
  });

  it("gives a customer in another country times in their own time and books the time they tapped", async () => {
    bookingService = catalog.haircut;
    const chat = await newChat();
    // An Indian number on a UAE (Asia/Dubai) branch: India is 1 h 30 ahead.
    await db
      .update(schema.contact)
      .set({ phone: `9198765${T.slice(-5)}` })
      .where(eq(schema.contact.id, chat.contactId));
    await customerSays(chat, "Can I book a haircut tomorrow?");
    const [q] = await until("the times", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    const options = (q?.content as { options?: { id: string; title: string }[] } | undefined)?.options ?? [];
    const first = options[0] as { id: string; title: string };
    // The branch opens at 9:00 UAE time, so no Indian time before 10:30 am is offered.
    const shownAt = first.title.match(/(\d{1,2}):(\d{2}) (am|pm)$/);
    assert.ok(shownAt, first.title);
    const shownMinutes =
      ((Number(shownAt[1]) % 12) + (shownAt[3] === "pm" ? 12 : 0)) * 60 + Number(shownAt[2]);
    assert.ok(shownMinutes >= 10 * 60 + 30, `${first.title} is India time`);
    const found = JSON.stringify(calls.at(-1)?.messages ?? []);
    assert.match(found, /India time, the customer's own/);
    assert.match(found, /UAE time/);

    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, first.title, first, q?.id ?? null);
    const asked = await until("the Yes / No question", async () => {
      const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
      return m.length === 2 ? m[1] : null;
    });
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    const yes = (asked.content as { options: { id: string; title: string }[] }).options[0] ?? null;
    await customerSays(chat, "Yes", yes, asked?.id ?? null);
    const [booked] = await until("the booking", async () => {
      const rows = await db
        .select()
        .from(schema.booking)
        .where(eq(schema.booking.conversationId, chat.conversationId));
      return rows.length ? rows : null;
    });
    // Booked at the time the customer saw, in India: 1 h 30 earlier on the branch's clock.
    const india = localTime(booked?.startsAt as Date, "Asia/Kolkata").minute;
    const uae = localTime(booked?.startsAt as Date, "Asia/Dubai").minute;
    assert.equal(india, shownMinutes);
    assert.equal(india - uae, 90);
    // The result Mira words her confirmation from has both, already worked out.
    await until("the confirmation", async () => {
      const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
      return m.length === 3 ? m : null;
    });
    const result = JSON.stringify(calls.at(-1)?.messages ?? []);
    assert.match(result, /"time\\?":\\?"[^"\\]+ India time/);
    assert.match(result, /"ourTime\\?":\\?"[^"\\]+ UAE time/);
  });

  it("marks a booking confirmed when the customer taps Confirm on a reminder, and says thanks", async () => {
    const chat = await newChat();
    const bookingId = `bkg_c${T}`;
    const start = new Date(Date.now() + 2 * 86_400_000);
    await db.insert(schema.booking).values({
      id: bookingId,
      organizationId: ids.org,
      branchId: ids.branch,
      variantId: null,
      contactId: chat.contactId,
      conversationId: chat.conversationId,
      title: "Haircut",
      reference: `R${T.slice(-5).toUpperCase()}`,
      startsAt: start,
      endsAt: new Date(start.getTime() + 1_800_000),
      bookedBy: "team",
    });
    const reminderId = `msg_r${T}`;
    await db.insert(schema.message).values({
      id: reminderId,
      organizationId: ids.org,
      conversationId: chat.conversationId,
      channelAccountId: ids.channel,
      direction: "outbound",
      senderType: "bot",
      type: "interactive",
      content: {
        type: "interactive",
        kind: "buttons",
        body: "Reminder",
        booking: { id: bookingId, reference: "X" },
      },
      status: "sent",
      sentAt: new Date(),
    });
    await customerSays(chat, "Confirm", { id: `bk_${bookingId}_confirm`, title: "Confirm" }, reminderId);
    const row = await until("confirmed", async () => {
      const [b] = await db.select().from(schema.booking).where(eq(schema.booking.id, bookingId));
      return b?.status === "confirmed" ? b : null;
    });
    assert.ok(row.confirmedAt);
    const thanks = await until("the thanks", async () => {
      const m = await db
        .select()
        .from(schema.message)
        .where(
          sql`${schema.message.conversationId} = ${chat.conversationId} and ${schema.message.senderType} = 'bot' and ${schema.message.type} = 'text'`,
        );
      return m.length ? m : null;
    });
    assert.match(textOf(thanks[0] as never), /you're confirmed for Haircut/);
    assert.equal((await agentMessages(chat.conversationId)).length, 0, "Mira doesn't also answer");
  });

  it("books an online service in the connected Google Calendar and sends the Meet link", async () => {
    const services = await db
      .select()
      .from(schema.catalogType)
      .where(
        sql`${schema.catalogType.organizationId} = ${ids.org} and ${schema.catalogType.kind} = 'service'`,
      );
    const consult = await saveCatalogItem(db, {
      organizationId: ids.org,
      branchId: ids.branch,
      userId: null,
      input: {
        typeId: services[0]?.id ?? "",
        title: "Consultation",
        description: "",
        attributes: {},
        status: "active",
        tags: [],
        variants: [
          {
            title: "",
            price: 200,
            currency: "AED",
            options: {},
            available: true,
            bookable: true,
            durationMinutes: 30,
            bookingOnline: true,
          },
        ],
      },
      newId: (k) => newId(k),
    });
    bookingService = consult.id;
    await db.insert(schema.calendarConnection).values({
      id: `cal_${T}`,
      organizationId: ids.org,
      branchId: ids.branch,
      accountEmail: "owner@lumen.test",
      refreshToken: encryptSecret("rt-1", calendarKey),
      calendarId: "owner@lumen.test",
      calendarName: "Lumen",
      status: "active",
    });
    const chat = await newChat();
    await customerSays(chat, "I'd like to book a consultation tomorrow");
    const [q] = await until("the times", async () => {
      const m = await agentMessages(chat.conversationId);
      return m.length ? m : null;
    });
    const times = q?.content as { options?: { id: string; title: string }[] } | undefined;
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, times?.options?.[0]?.title ?? "", times?.options?.[0] ?? null, q?.id ?? null);
    const asked = await until("the question", async () => {
      const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
      return m.length === 2 ? m[1] : null;
    });
    const yes = (asked?.content as { options?: { id: string; title: string }[] } | undefined)?.options?.[0];
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, "Yes", yes ?? null, asked?.id ?? null);
    const reply = await until("the confirmation", async () => {
      const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
      return m.length === 3 ? m[2] : null;
    });
    assert.match(textOf(reply as never), /^All booked! [A-Z2-9]{6} https:\/\/meet\.google\.com\//);
    const [b] = await db
      .select()
      .from(schema.booking)
      .where(eq(schema.booking.conversationId, chat.conversationId));
    assert.equal(b?.calendarSync, "synced");
    assert.ok(
      google.state.events.some((e) => e.meetRequestId === b?.id),
      "the event in Google asked for Meet",
    );

    // Then they want the invite by email: the guest is added and Google emails it.
    await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
    await customerSays(chat, `Please invite me to ${b?.reference}: Asha@Example.com`);
    const invited = await until("the invite", async () => {
      const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
      return m.length === 4 ? m[3] : null;
    });
    assert.match(textOf(invited as never), /"invited":true/);
    const [after] = await db
      .select()
      .from(schema.booking)
      .where(eq(schema.booking.id, b?.id ?? ""));
    assert.deepEqual(after?.guestEmails, ["asha@example.com"]);
    const ev = google.state.events.find((e) => e.meetRequestId === b?.id);
    assert.deepEqual(ev?.body.attendees, [{ email: "asha@example.com" }]);
    assert.equal(ev?.sendUpdates.at(-1), "all");
    const notes = (await agentMessages(chat.conversationId)).filter((x) => x.type === "note");
    assert.ok(
      notes.some((n) => /invited asha@example\.com/.test(JSON.stringify(n.content))),
      "noted for the team",
    );
  });
});

describe("follow-ups in Google Tasks", () => {
  it("adds a callback once to the chosen list, notes it in the chat, and adds one for a hand-over", async () => {
    google.state.taskLists.push({ id: "list-wa", title: "WhatsApp follow-ups" });
    await db.insert(schema.taskConnection).values({
      id: `tsc_${T}`,
      organizationId: ids.org,
      branchId: ids.branch,
      accountEmail: "owner@lumen.test",
      refreshToken: encryptSecret("rt-1", calendarKey),
      listId: "list-wa",
      listName: "WhatsApp follow-ups",
      lists: [{ id: "list-wa", name: "WhatsApp follow-ups" }],
      enabled: true,
      onHandoff: true,
    });
    try {
      const chat = await newChat();
      await customerSays(chat, "can you call me back tomorrow?");
      const reply = await until("the reply", async () => {
        const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
        return m.length ? m[0] : null;
      });
      assert.match(textOf(reply as never), /"added":true/);
      assert.match(calls.at(-1)?.system ?? "", /## Follow-ups for the team/);
      const added = google.state.tasks.filter((t) => t.listId === "list-wa");
      assert.equal(added.length, 1);
      assert.equal(added[0]?.title, "Call back Asha about pricing");
      assert.equal(added[0]?.due, `${tomorrow}T00:00:00.000Z`);
      assert.match(added[0]?.notes ?? "", /Wants a call after 5 pm\./);
      assert.match(added[0]?.notes ?? "", /Customer: Asha, \+97150\d+/);
      assert.match(
        added[0]?.notes ?? "",
        new RegExp(`https://app\\.test/conversations\\?view=all&c=${chat.conversationId}`),
      );
      const [row] = await db
        .select()
        .from(schema.agentTask)
        .where(eq(schema.agentTask.conversationId, chat.conversationId));
      assert.equal(row?.status, "open");
      assert.equal(row?.externalTaskId, added[0]?.id);
      const note = (await agentMessages(chat.conversationId)).find((m) => m.type === "note");
      assert.match(
        textOf(note as never),
        /Follow-up added to Google Tasks: Call back Asha about pricing \(due /,
      );

      // Asking again the same day: Mira sees it's already there, and it isn't added twice.
      await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
      await customerSays(chat, "please call me back tomorrow");
      await until("the second reply", async () => {
        const m = (await agentMessages(chat.conversationId)).filter((x) => x.type !== "note");
        return m.length === 2 ? m : null;
      });
      assert.match(
        JSON.stringify(calls.at(-2)?.messages ?? []),
        /Follow-ups already added for the team in this chat/,
      );
      assert.equal(google.state.tasks.filter((t) => t.listId === "list-wa").length, 1);

      // A hand-over adds its own task, due today.
      await until("waiting", async () => (await agentRun(chat.conversationId))?.status === "waiting");
      await customerSays(chat, "I want a person");
      const handoff = await until("the hand-over task", async () => {
        const t = google.state.tasks.filter((x) => x.listId === "list-wa");
        return t.length === 2 ? t[1] : null;
      });
      assert.equal(handoff?.title, "Reply on WhatsApp: Asked for a person");
      assert.equal(handoff?.due, `${localTime(new Date(), "Asia/Dubai").date}T00:00:00.000Z`);
      const rows = await db
        .select()
        .from(schema.agentTask)
        .where(eq(schema.agentTask.conversationId, chat.conversationId));
      assert.deepEqual(rows.map((x) => x.source).sort(), ["agent", "handoff"]);
    } finally {
      await db.delete(schema.taskConnection).where(eq(schema.taskConnection.id, `tsc_${T}`));
    }
  });
});
