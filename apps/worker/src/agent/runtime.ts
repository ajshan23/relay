import { createHash } from "node:crypto";
import {
  type AgentProfile,
  type BookingDeps,
  bookingToolRef,
  builtinTools,
  type ChatLine,
  type ConnectOptions,
  type ContactFacts,
  type CustomToolDef,
  chatMessages,
  contextNote,
  costMicros,
  createToolRunner,
  creditsFor,
  customTools,
  defaultMonthlyCredits,
  type Embedder,
  envelope,
  type FollowUpInput,
  type ModelCaller,
  modelFor,
  openFollowUpsNote,
  photoLine,
  type RunContext,
  runTool,
  runTurn,
  type Speaker,
  searchTerms,
  speechCostMicros,
  speechLanguage,
  speechText,
  systemPrompt,
  type TurnOutcome,
  voiceNoteLine,
  voiceReplyLimits,
} from "@relay/agent";
import {
  decryptSecretJson,
  type FileStorage,
  newId,
  type Publisher,
  previewText,
  publishInboxEvent,
} from "@relay/core";
import { agentToolLimits, type McpToolConfig, type ToolSecret } from "@relay/core/agent-tools";
import {
  type AgentRunInput,
  type AgentRunLabels,
  agentHandoffSchema,
  agentLimits,
  agentWorkflow,
  withinAgentHours,
} from "@relay/core/agents";
import {
  automationEvents,
  type InboundEventPayload,
  optionOfReply,
  optionReplyId,
} from "@relay/core/automations";
import {
  bookingRangeLabel,
  bookingReplyOf,
  bookingTimeLabel,
  localTime,
  phoneTimezone,
  timezonePlace,
  zonedTime,
} from "@relay/core/bookings";
import { taskDueDate, taskDueLabel } from "@relay/core/google-tasks";
import {
  addFollowUpTask,
  agentFreeTimes,
  aiCredits,
  and,
  bookableServices,
  bookingProblem,
  bookingSettingsOf,
  type CalendarDeps,
  catalogAgentDeps,
  catalogShape,
  cleanGuestEmails,
  createBooking,
  createCatalogPresenter,
  type createDb,
  desc,
  eq,
  gt,
  inArray,
  insertOutboundMessage,
  maxBookingGuests,
  moveBooking,
  ne,
  openFollowUps,
  recordAiUsage,
  saveBookingGuests,
  schema,
  searchKnowledge,
  setBookingStatus,
  sql,
  sqlExecutor,
  storeFile,
  taskConnectionOf,
  upcomingBookingsFor,
} from "@relay/db";
import { isKairosControl, type Kairos, type RunRow, type WorkflowContext } from "@relay/kairos";
import type { Queue } from "bullmq";
import type { PhotoReader } from "./photos";
import { toVoiceNote } from "./speech";
import type { VoiceListener } from "./voice";

/*
 * The AI agent in a chat, as a Kairos run (workflow relay.mira) that holds the chat the way an
 * automation run does (conversation.automation_run_id, plus conversation.ai_agent_id).
 *
 *   start (unclaimed message or "Hand to AI agent") → answer the message that started it
 *   loop: wait for the customer → gather quick follow-ups → one turn → reply / hand over / close
 *
 * Every model call, tool call and send is a recorded step, so a restart replays without asking the
 * model again, sending twice or counting usage twice. A team member's reply cancels the run (inbox),
 * STOP cancels it (router), 24 hours of silence ends it, and the chat is always released at the end.
 */

type Db = ReturnType<typeof createDb>["db"];

/** A photo, voice note or video with no caption: the customer's words usually follow. */
const isBareMedia = (e: InboundEventPayload) =>
  ["image", "audio", "video"].includes(e.type) && !e.text.trim();
type Conversation = typeof schema.conversation.$inferSelect;
const finished = new Set(["completed", "failed", "cancelled"]);
const isLive = (r: RunRow | null | undefined) => !!r && !finished.has(r.status);

/** How a run ended (its output), read before answering an unclaimed chat again. */
type Ended = "handoff" | "close" | "idle" | "max_turns" | "send_failed" | "not_live" | "stopped" | "paused";

export type AgentRuntimeDeps = {
  db: Db;
  kairos: Kairos;
  redis: Publisher;
  outbox: Pick<Queue, "add">;
  outboxJobOptions: Record<string, unknown>;
  /** "typing…" on the customer's last message (false when it can't be shown). */
  showTyping: (conversationId: string, key: string) => Promise<boolean>;
  /** Null when no AI key is set: the agent hands chats straight to a person. */
  callModel: ModelCaller | null;
  embed: Embedder | null;
  /** 512-dim embeddings for catalogue searches (null without an AI key: words only). */
  embedCatalog?: Embedder | null;
  /** Turns the customer's voice notes into text before the agent answers (null: not heard). */
  hearVoiceNotes?: VoiceListener | null;
  /** Describes the customer's photos before the agent answers (null: not looked at). */
  seePhotos?: PhotoReader | null;
  /** Speaks plain replies as WhatsApp voice notes (null: replies are always text). */
  voiceReplies?: {
    speak: Speaker;
    storage: FileStorage;
    /** MP3 → Ogg/Opus voice note (ffmpeg); replaceable in tests. */
    encode?: typeof toVoiceNote;
  } | null;
  /** The branches' Google Calendars (busy times, events, Meet links); null: Relay's book only. */
  calendar?: CalendarDeps | null;
  /** Calls the business's own tools (API calls, MCP servers); null: they aren't offered. */
  ownTools?: (ConnectOptions & { secretKey: string }) | null;
};

/** A business tool's Yes / No question, kept on the message that asks it. */
type PendingAction = {
  toolId: string;
  toolName: string;
  mcpTool?: string;
  title: string;
  input: unknown;
  question: string;
  expiresAt: string;
  /** Set once answered (Yes or No), so a second tap does nothing. */
  doneAt?: string;
  answer?: "yes" | "no";
};

export function createAgentRuntime(d: AgentRuntimeDeps) {
  const { db, kairos } = d;
  const presenter = createCatalogPresenter({ db });

  const announce = (c: { organizationId: string; id: string; branchId: string | null }) =>
    publishInboxEvent(d.redis, c.organizationId, {
      type: "conversation.updated",
      conversationId: c.id,
      branchId: c.branchId,
    });

  async function conversationOf(id: string) {
    const [c] = await db.select().from(schema.conversation).where(eq(schema.conversation.id, id)).limit(1);
    return c ?? null;
  }

  /** Frees the chat if this run still holds it. */
  async function release(conversationId: string, runId: string) {
    const rows = await db
      .update(schema.conversation)
      .set({ automationRunId: null, aiAgentId: null, updatedAt: new Date() })
      .where(and(eq(schema.conversation.id, conversationId), eq(schema.conversation.automationRunId, runId)))
      .returning();
    if (rows[0]) await announce(rows[0]);
  }

  // ------------------------------------------------------------------ starting

  /**
   * Starts the agent in a chat and puts it in charge, in `tx` when given (the automation step's own
   * transaction) or a new one. Null when another live run holds the chat.
   */
  async function startRun(o: {
    agentId: string;
    conversation: Conversation;
    contactId: string;
    source: AgentRunInput["source"];
    trigger: AgentRunInput["trigger"];
    idempotencyKey: string;
    automationId?: string;
    greeting?: string;
    /** The run handing the chat over (it may hold the chat). */
    fromRunId?: string;
  }): Promise<string | null> {
    const c = o.conversation;
    const input: AgentRunInput = {
      agentId: o.agentId,
      organizationId: c.organizationId,
      branchId: c.branchId ?? "",
      channelAccountId: c.channelAccountId,
      conversationId: c.id,
      contactId: o.contactId,
      source: o.source,
      trigger: o.trigger,
      ...(o.automationId ? { automationId: o.automationId } : {}),
      ...(o.greeting ? { greeting: o.greeting } : {}),
    };
    const labels: AgentRunLabels = {
      agentId: o.agentId,
      contactId: o.contactId,
      conversationId: c.id,
      ai: true,
      stopOnAgentReply: true,
      stopOnOptOut: true,
    };
    const runId = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ automationRunId: schema.conversation.automationRunId })
        .from(schema.conversation)
        .where(eq(schema.conversation.id, c.id))
        .for("update");
      const holder = locked?.automationRunId;
      if (holder && holder !== o.fromRunId && isLive((await kairos.getRun(holder))?.run)) return null;
      const { runId } = await kairos.start(run, input, {
        tenantId: c.organizationId,
        serialKey: c.id,
        idempotencyKey: o.idempotencyKey,
        labels,
        executor: sqlExecutor(tx),
      });
      await tx
        .update(schema.conversation)
        .set({ automationRunId: runId, aiAgentId: o.agentId, updatedAt: new Date() })
        .where(eq(schema.conversation.id, c.id));
      return runId;
    });
    if (!runId) return null;
    kairos.nudge();
    await announce(c);
    return runId;
  }

  /**
   * Why an agent shouldn't take this chat now, or null when it can: it isn't live, it's outside its
   * hours, or in the last day it handed this chat to the team or the team stepped in. The same rules
   * whether the chat came unclaimed or an automation's "Hand to AI agent" step passed it on.
   */
  async function whyNotTake(
    agent: Pick<typeof schema.aiAgent.$inferSelect, "status" | "hours">,
    conversationId: string,
  ): Promise<"not_live" | "outside_hours" | "recently_handed_over" | "team_took_over" | null> {
    if (agent.status !== "live") return "not_live";
    if (!withinAgentHours(agent.hours)) return "outside_hours";
    const [last] = await kairos.listRuns({
      workflow: agentWorkflow.name,
      labels: { conversationId },
      limit: 1,
    });
    const recent = last?.finished_at && Date.now() - new Date(last.finished_at).getTime() < 24 * 3_600_000;
    const handedOver = (last?.output as { ended?: Ended } | null)?.ended === "handoff";
    if (recent && (handedOver || last?.status === "cancelled"))
      return handedOver ? "recently_handed_over" : "team_took_over";
    return null;
  }

  /** An automation's "Hand to AI agent" step: the agent row (any branch status) and why not, if so. */
  async function canTake(agentId: string, conversationId: string) {
    const [agent] = await db.select().from(schema.aiAgent).where(eq(schema.aiAgent.id, agentId)).limit(1);
    if (!agent) return { agent: null, blocked: "no_agent" as const };
    return { agent, blocked: await whyNotTake(agent, conversationId) };
  }

  /**
   * The router found no automation for a customer message: the branch's agent answers it when it is
   * live, answers unclaimed chats, it's within its hours, nobody is assigned, and the agent didn't just
   * hand this chat over (or get stopped by the team) in the last day.
   */
  async function maybeStartUnclaimed(conv: Conversation, ev: InboundEventPayload) {
    if (!d.callModel) return { action: "none", reason: "ai_not_configured" };
    if (conv.kind !== "direct" || !conv.branchId || !conv.contactId)
      return { action: "none", reason: "not_direct" };
    if (conv.assignedUserId) return { action: "none", reason: "chat_assigned" };
    if (ev.optOut) return { action: "none", reason: "opt_out" };
    const [agent] = await db
      .select()
      .from(schema.aiAgent)
      .where(
        and(
          eq(schema.aiAgent.branchId, conv.branchId),
          eq(schema.aiAgent.status, "live"),
          eq(schema.aiAgent.answerUnclaimed, true),
        ),
      )
      .limit(1);
    if (!agent) return { action: "none", reason: "no_agent" };
    const blocked = await whyNotTake(agent, conv.id);
    if (blocked) return { action: "none", reason: blocked };
    const runId = await startRun({
      agentId: agent.id,
      conversation: conv,
      contactId: conv.contactId,
      source: "unclaimed",
      trigger: { messageId: ev.messageId, text: ev.text },
      idempotencyKey: `ai:${ev.messageId}`,
    });
    return runId
      ? { action: "ai_started", agentId: agent.id, runId }
      : { action: "ignored", reason: "chat_in_automation" };
  }

  // ------------------------------------------------------------------ the run

  const run = kairos.workflow<AgentRunInput, { ended: Ended; turns: number }>(
    { ...agentWorkflow, retries: 3, backoff: { baseMs: 2_000 }, stepTimeoutMs: 120_000 },
    async (ctx, input) => {
      let turns = 0;
      let ended: Ended = "idle";
      try {
        // Recorded with the agent (not as a step of its own) so runs started before this check replay.
        const agent = await ctx.step("load agent", async () => {
          const a = await loadAgent(input.agentId, input.organizationId);
          return a && input.trigger
            ? { ...a, triggerAnswered: await lastWordIsOurs(input.conversationId) }
            : a;
        });
        if (agent?.status !== "live") {
          ended = "not_live";
        } else {
          ended = await converse(ctx, input, agent, (n) => {
            turns = n;
          });
        }
      } catch (err) {
        if (isKairosControl(err)) throw err;
        await ctx.step("release chat", () => release(input.conversationId, ctx.runId));
        throw err;
      }
      await ctx.step("release chat", () => release(input.conversationId, ctx.runId));
      return { ended, turns };
    },
  );

  /** The agent's settings, frozen for this run (a mid-chat edit applies from the next chat). */
  async function loadAgent(agentId: string, orgId: string) {
    const [a] = await db
      .select()
      .from(schema.aiAgent)
      .where(and(eq(schema.aiAgent.id, agentId), eq(schema.aiAgent.organizationId, orgId)))
      .limit(1);
    if (!a) return null;
    const [org] = await db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId))
      .limit(1);
    const fields = a.editableFields.length
      ? await db
          .select({ key: schema.contactField.key, label: schema.contactField.label })
          .from(schema.contactField)
          .where(
            and(
              eq(schema.contactField.organizationId, orgId),
              inArray(schema.contactField.key, a.editableFields),
            ),
          )
      : [];
    const catalog = await catalogShape(db, orgId, a.branchId);
    // The business's own tools (keys stay in the database; they're read when a tool is called).
    const tools = d.ownTools
      ? (
          await db
            .select({
              id: schema.aiTool.id,
              kind: schema.aiTool.kind,
              name: schema.aiTool.name,
              title: schema.aiTool.title,
              description: schema.aiTool.description,
              confirm: schema.aiTool.confirm,
              config: schema.aiTool.config,
            })
            .from(schema.aiTool)
            .where(and(eq(schema.aiTool.agentId, a.id), eq(schema.aiTool.enabled, true)))
            .orderBy(schema.aiTool.createdAt)
            .limit(agentToolLimits.perAgent)
        ).flatMap((t) => {
          if (t.kind === "http") return [t];
          const config = t.config as McpToolConfig;
          const allowed = config.tools.filter((x) => x.allowed);
          return allowed.length ? [{ ...t, config: { ...config, tools: allowed } }] : [];
        })
      : [];
    // Booking: the branch takes bookings and has services that can be booked.
    const bookingSetup = await bookingSettingsOf(db, orgId, a.branchId);
    const services = bookingSetup.enabled
      ? await bookableServices(db, { organizationId: orgId, branchId: a.branchId })
      : [];
    // Follow-ups for the team: the branch connected Google Tasks and chose a list.
    const taskConn = d.calendar ? await taskConnectionOf(db, orgId, a.branchId) : null;
    const tasks =
      taskConn?.listId && taskConn.status === "active"
        ? { enabled: taskConn.enabled, onHandoff: taskConn.onHandoff, timezone: bookingSetup.timezone }
        : null;
    const booking = services.length
      ? {
          timezone: bookingSetup.timezone,
          services: services.map((s) => ({
            variantId: s.variantId,
            itemId: s.itemId,
            title: s.title,
            durationMinutes: s.durationMinutes,
          })),
        }
      : null;
    return {
      id: a.id,
      status: a.status,
      name: a.name,
      model: a.model,
      engine: a.engine,
      voiceNotes: a.voiceNotes,
      photos: a.photos,
      voiceReplies: a.voiceReplies,
      handoff: a.handoff,
      profile: {
        name: a.name,
        role: a.role,
        businessName: org?.name ?? "the business",
        instructions: a.instructions,
        tone: a.tone,
        languages: a.languages,
        handoffWhen: a.handoff.when,
        catalog: !!catalog,
        hearsVoiceNotes: a.voiceNotes !== "off" && !!d.hearVoiceNotes,
        seesPhotos: a.photos !== "off" && !!d.seePhotos,
        repliesByVoice: a.voiceReplies !== "off" && !!d.voiceReplies,
        ownTools: tools.length > 0,
        booking: !!booking,
        followUps: !!tasks?.enabled,
      } satisfies AgentProfile,
      editableFields: fields,
      /** What the branch sells (null: no catalogue tools). Frozen for the run like the rest. */
      catalog,
      /** The business's own tools, without their keys. */
      tools: tools as Omit<CustomToolDef, "secret">[],
      /** Booking services and the branch's timezone (null: no booking tools). */
      booking,
      /** Google Tasks for follow-ups (null: not connected). */
      tasks,
    };
  }
  type LoadedAgent = NonNullable<Awaited<ReturnType<typeof loadAgent>>> & {
    /** The chat's last message was already ours (an automation answered the trigger before handing over). */
    triggerAnswered?: boolean;
  };

  /** The customer wrote something (reactions aside) after `since`. */
  async function customerWroteSince(conversationId: string, since: Date) {
    const m = schema.message;
    const [row] = await db
      .select({ id: m.id })
      .from(m)
      .where(
        and(
          eq(m.conversationId, conversationId),
          eq(m.direction, "inbound"),
          ne(m.type, "reaction"),
          gt(m.createdAt, since),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** True when the newest message in the chat (notes and reactions aside) went out from the business. */
  async function lastWordIsOurs(conversationId: string) {
    const m = schema.message;
    const [last] = await db
      .select({ direction: m.direction })
      .from(m)
      .where(and(eq(m.conversationId, conversationId), ne(m.type, "reaction"), ne(m.type, "note")))
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(1);
    return last?.direction === "outbound";
  }

  async function converse(
    ctx: WorkflowContext,
    input: AgentRunInput,
    started: LoadedAgent,
    onTurn: (n: number) => void,
  ): Promise<Ended> {
    // The agent as of this turn: re-read before every answer (below), so a change to Teach, knowledge
    // or the catalogue applies from the customer's next message, also in chats already going.
    let agent = started;
    const key = automationEvents.messageReceived;
    const scope = input.conversationId;
    // Where the next wait looks back from: messages written since then count (none are skipped).
    let lookbackFrom = "load agent";
    // Answer the message that started the run, unless an automation already did ("Hi" → "Hi" → hand to
    // AI): then wait for the customer's next message instead of greeting them a second time.
    let pending = !!input.trigger && !agent.triggerAnswered;
    // Drafts dropped in a row because the customer wrote again while they were being written.
    let rethinks = 0;
    let rethinking = false;
    // What a Yes / No tap led to, kept until an answer about it actually goes out.
    let heldActNote: string | null = null;
    if (input.greeting) {
      const sent = await ctx.step("greeting", () =>
        sendText(input, agent, `${ctx.runId}:greeting`, input.greeting as string),
      );
      if (!sent.ok) return "send_failed";
      lookbackFrom = "greeting";
      pending = false;
    }
    for (let turn = 1; ; turn++) {
      // The customer's newest message this turn, to see whether it's a tap on one of our item cards.
      let latest: InboundEventPayload | null = null;
      if (!pending) {
        const name = `wait${turn}`;
        const got = await ctx.waitForEvent<InboundEventPayload>(name, {
          key,
          scope,
          timeoutMs: agentLimits.idleMs,
          lookbackFrom,
        });
        if (got.timedOut) return "idle";
        if (got.event.payload.optOut === "stop") return "stopped";
        latest = got.event.payload;
        lookbackFrom = name;
      }
      // A photo or voice note with no words: the question usually follows, so wait a little longer.
      let bareMedia = latest
        ? isBareMedia(latest)
        : pending && !rethinking && !!input.trigger && !input.trigger.text.trim();
      pending = false;
      rethinking = false;
      // Several quick messages ("hi" / "price?" / "for 2") make one answer.
      for (let k = 0; k < agentLimits.gatherMax; k++) {
        const name = `t${turn}:more${k}`;
        const more = await ctx.waitForEvent<InboundEventPayload>(name, {
          key,
          scope,
          timeoutMs: bareMedia ? agentLimits.gatherAfterMediaMs : agentLimits.gatherMs,
          lookbackFrom,
        });
        if (more.timedOut) break;
        if (more.event.payload.optOut === "stop") return "stopped";
        latest = more.event.payload;
        bareMedia = isBareMedia(latest);
        lookbackFrom = name;
      }
      onTurn(turn);
      if (turn > agentLimits.maxTurns) {
        await ctx.step(`t${turn}:handoff`, () =>
          handOver(input, agent, `${ctx.runId}:t${turn}`, {
            kind: "handoff",
            reason: "A long chat",
            summary: `${agent.name} answered ${agentLimits.maxTurns} messages in this chat; a person should take it from here.`,
          }),
        );
        return "max_turns";
      }
      // Paused (or set back to draft) since the chat started: step back. Otherwise answer with the
      // agent's current settings. Turns recorded before this re-read hold a plain true/false.
      // Voice notes are heard here too (turned into text on the message), so the answer below reads
      // them like typed messages; folded into this step so chats already running replay unchanged.
      const now = await ctx.step(`t${turn}:live`, async (): Promise<LoadedAgent | false> => {
        const fresh = await loadAgent(agent.id, input.organizationId);
        if (fresh?.status !== "live") return false;
        if (d.hearVoiceNotes && fresh.voiceNotes !== "off") {
          try {
            await d.hearVoiceNotes({
              organizationId: input.organizationId,
              branchId: input.branchId,
              conversationId: input.conversationId,
              agentId: fresh.id,
              runId: ctx.runId,
              choice: fresh.voiceNotes,
              stepKey: `${ctx.runId}:t${turn}`,
            });
          } catch (err) {
            console.warn("[agent] voice notes not heard:", (err as Error).message);
          }
        }
        if (d.seePhotos && fresh.photos !== "off") {
          try {
            await d.seePhotos({
              organizationId: input.organizationId,
              branchId: input.branchId,
              conversationId: input.conversationId,
              agentId: fresh.id,
              runId: ctx.runId,
              choice: fresh.photos,
              stepKey: `${ctx.runId}:t${turn}`,
            });
          } catch (err) {
            console.warn("[agent] photos not looked at:", (err as Error).message);
          }
        }
        return fresh;
      });
      if (now && typeof now === "object") agent = { ...now, triggerAnswered: agent.triggerAnswered };
      if (!now) {
        await ctx.step(`t${turn}:paused`, () =>
          addNote(
            input,
            agent,
            `${ctx.runId}:t${turn}:paused`,
            `${agent.name} is paused, so this chat is back with your team.`,
          ),
        );
        return "paused";
      }
      // "More details" on an item card sends its gallery, and a tapped list row its card, straight
      // away: no model call and no credit. Order or Book goes to the agent like any message.
      const tap = latest?.reply ? await presenter.readTap(latest.messageId, latest.reply.id) : null;
      if (tap && (tap.action === "more" || tap.action === "select")) {
        const tapStep = `t${turn}:gallery`;
        const args = {
          organizationId: input.organizationId,
          branchId: input.branchId,
          send: sender(input, agent),
          stepKey: `${ctx.runId}:t${turn}`,
          itemId: tap.itemId,
        };
        const sent = await ctx.step(tapStep, () =>
          tap.action === "more" ? presenter.showGallery(args) : presenter.showItemCard(args),
        );
        if (!sent.ok) return "send_failed";
        lookbackFrom = tapStep;
        continue;
      }
      // A tap on Yes or No under one of the agent's "shall I go ahead?" questions: carry it out (once,
      // inside its own step) and let the model tell the customer how it went.
      const confirmTap = latest?.reply ? await confirmTapOf(latest.messageId, latest.reply.id) : null;
      const actNote: string | null = confirmTap
        ? await ctx.step(`t${turn}:act`, () => carryOut(input, agent, confirmTap))
        : heldActNote;
      const typingStep = `t${turn}:typing`;
      await ctx.step(typingStep, () => d.showTyping(input.conversationId, `${ctx.runId}_t${turn}`));
      const read: { at?: Date } = {};
      const outcome = await oneTurn(ctx, input, agent, turn, read, actNote);
      lookbackFrom = typingStep;
      const stepKey = `${ctx.runId}:t${turn}`;
      // Just before the answer goes out: if the customer wrote again since the chat was read, drop
      // this draft and answer everything together (decided inside the send step, so replays agree).
      let superseded = false;
      const sendUnlessStale = <T extends { ok: boolean }>(send: () => Promise<T>) =>
        ctx.step(
          `t${turn}:send`,
          async (): Promise<T | { ok: true; superseded: true }> =>
            rethinks < agentLimits.maxRethinks &&
            read.at &&
            (await customerWroteSince(input.conversationId, read.at))
              ? { ok: true, superseded: true }
              : send(),
        );
      switch (outcome.kind) {
        case "silent":
          break;
        case "reply": {
          const sent = await sendUnlessStale(() => sendReply(input, agent, stepKey, outcome.text));
          if (!sent.ok) return "send_failed";
          if ("superseded" in sent) {
            superseded = true;
            break;
          }
          if (outcome.gap) {
            const question = outcome.gap;
            await ctx.step(`t${turn}:gap`, () => noteGap(input, agent, `${stepKey}:gap`, question));
          }
          break;
        }
        case "options": {
          const sent = await sendUnlessStale(() => sendOptions(input, agent, stepKey, outcome));
          if (!sent.ok) return "send_failed";
          if ("superseded" in sent) {
            superseded = true;
            break;
          }
          break;
        }
        case "items": {
          const sent = await sendUnlessStale(() =>
            presenter.showItems({
              organizationId: input.organizationId,
              branchId: input.branchId,
              send: sender(input, agent),
              stepKey,
              itemIds: outcome.itemIds,
              action: outcome.action,
              text: outcome.text,
            }),
          );
          if (!sent.ok) return "send_failed";
          if ("superseded" in sent) {
            superseded = true;
            break;
          }
          break;
        }
        case "media": {
          const sent = await sendUnlessStale(() =>
            presenter.showGallery({
              organizationId: input.organizationId,
              branchId: input.branchId,
              send: sender(input, agent),
              stepKey,
              itemId: outcome.itemId,
              text: outcome.text,
            }),
          );
          if (!sent.ok) return "send_failed";
          if ("superseded" in sent) {
            superseded = true;
            break;
          }
          break;
        }
        case "confirm": {
          const sent = await sendUnlessStale(() => sendConfirm(input, agent, stepKey, outcome));
          if (!sent.ok) return "send_failed";
          if ("superseded" in sent) {
            superseded = true;
            break;
          }
          break;
        }
        case "handoff":
          await ctx.step(`t${turn}:handoff`, () => handOver(input, agent, stepKey, outcome));
          return "handoff";
        case "close":
          await ctx.step(`t${turn}:close`, () => closeChat(input, agent, stepKey, outcome));
          return "close";
      }
      heldActNote = superseded ? actNote : null;
      if (superseded) {
        // Answer again straight away with the new messages (and any that follow in the next seconds).
        rethinks++;
        rethinking = true;
        pending = true;
        lookbackFrom = `t${turn}:send`;
        continue;
      }
      rethinks = 0;
    }
  }

  /** One answer: check credits, build the prompt from the chat, run the bounded tool loop. */
  async function oneTurn(
    ctx: WorkflowContext,
    input: AgentRunInput,
    agent: LoadedAgent,
    turn: number,
    /** Filled with when the chat was read, so a newer customer message can drop this draft. */
    read: { at?: Date } = {},
    /** What happened to a Yes / No question the customer just answered, for the model to pass on. */
    actNote: string | null = null,
  ): Promise<TurnOutcome> {
    const prefix = `t${turn}`;
    const left = await ctx.step(
      `${prefix}:credits`,
      async () => (await aiCredits(db, input.organizationId, defaultMonthlyCredits)).left,
    );
    if (left <= 0)
      return {
        kind: "handoff",
        reason: "AI credits used up",
        summary: "This month's AI credits are used up, so the AI agent stopped answering.",
      };
    if (!d.callModel)
      return {
        kind: "handoff",
        reason: "AI isn't set up",
        summary: "The AI agent can't answer: no AI key is configured on the server.",
      };
    const callModel = d.callModel;

    read.at = new Date();
    const [lines, contact] = await Promise.all([
      chatLines(input.conversationId, {
        hears: agent.profile.hearsVoiceNotes ?? false,
        sees: agent.profile.seesPhotos ?? false,
      }),
      contactFacts(input.contactId, agent),
    ]);
    const runCtx = await liveContext(input, agent);
    const tools = agentTools(agent, runCtx);
    const messages = chatMessages(lines, contextNote(runCtx, contact, agent.profile.languages));
    if (agent.tasks?.enabled) {
      const open = await openFollowUps(
        db,
        d.calendar ?? null,
        input.organizationId,
        input.branchId,
        input.conversationId,
      ).catch(() => []);
      const note = openFollowUpsNote(
        open.map((t) => ({ title: t.title, due: t.dueDate ? taskDueLabel(t.dueDate) : null })),
      );
      if (note) messages.push({ role: "system", content: note });
    }
    if (actNote) messages.push({ role: "system", content: actNote });
    try {
      const result = await runTurn({
        model: modelFor(agent.model, process.env, agent.engine),
        system: systemPrompt(agent.profile),
        messages,
        tools,
        ctx: runCtx,
        callModel,
        step: (name, fn) => ctx.step(name, fn),
        stepPrefix: prefix,
        onModelCall: (r, i) =>
          recordAiUsage(db, {
            id: newId("aiUsage"),
            organizationId: input.organizationId,
            branchId: input.branchId,
            agentId: agent.id,
            conversationId: input.conversationId,
            runId: ctx.runId,
            stepKey: `${ctx.runId}:${prefix}:model${i}`,
            kind: "reply",
            model: r.model,
            inputTokens: r.usage.inputTokens,
            cachedTokens: r.usage.cachedTokens,
            outputTokens: r.usage.outputTokens,
            costMicros: costMicros(r.model, r.usage),
            credits: creditsFor("reply", i),
            latencyMs: r.latencyMs,
          }),
      });
      return result.outcome;
    } catch (err) {
      if (isKairosControl(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`ai agent ${agent.id} turn failed in ${input.conversationId}: ${message}`);
      return {
        kind: "handoff",
        reason: "The AI had a problem",
        summary: `The AI agent couldn't answer (${message.slice(0, 160)}).`,
      };
    }
  }

  /** Who and where a live turn is for (the contact's details too, for the business's own tools). */
  async function liveContext(input: AgentRunInput, agent: LoadedAgent): Promise<RunContext> {
    const runCtx: RunContext = {
      orgId: input.organizationId,
      branchId: input.branchId,
      agentId: agent.id,
      conversationId: input.conversationId,
      contactId: input.contactId,
      mode: "live",
      timezone: await branchTimezone(input.branchId),
      now: new Date(),
    };
    if (agent.tools?.length) {
      const [c] = await db
        .select({
          name: schema.contact.name,
          phone: schema.contact.phone,
          attributes: schema.contact.attributes,
        })
        .from(schema.contact)
        .where(eq(schema.contact.id, input.contactId))
        .limit(1);
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries((c?.attributes ?? {}) as Record<string, unknown>))
        if (v != null && typeof v !== "object") fields[k] = String(v);
      runCtx.contact = { phone: c?.phone ?? null, name: c?.name ?? null, fields };
    }
    // Booking times are given in the customer's own time when their number says where they are.
    if (agent.booking) {
      const phone =
        runCtx.contact?.phone ??
        (
          await db
            .select({ phone: schema.contact.phone })
            .from(schema.contact)
            .where(eq(schema.contact.id, input.contactId))
            .limit(1)
        )[0]?.phone;
      runCtx.customerZone = phoneTimezone(phone);
    }
    return runCtx;
  }

  /** The business's own tools, calling out with the key read only at call time, and each call logged. */
  function ownTools(agent: LoadedAgent) {
    const net = d.ownTools;
    if (!net || !agent.tools?.length) return [];
    const defs = agent.tools.map((t) => ({ ...t, secret: null }) as CustomToolDef);
    return customTools(defs, async (def, mcpTool, args, rc) => {
      const run = createToolRunner({
        ...net,
        onCall: (l) =>
          logToolCall({
            organizationId: rc.orgId,
            agentId: agent.id,
            toolId: def.id,
            conversationId: rc.conversationId,
            name: mcpTool ? `${def.name}__${mcpTool}` : def.name,
            mode: rc.mode,
            status: l.ok ? "ok" : "error",
            httpStatus: l.httpStatus,
            ms: l.ms,
            error: l.error,
          }),
      });
      return run({ ...def, secret: await toolSecret(def.id) } as CustomToolDef, mcpTool, args, rc);
    });
  }

  async function toolSecret(toolId: string): Promise<ToolSecret | null> {
    const [t] = await db
      .select({ secret: schema.aiTool.secret })
      .from(schema.aiTool)
      .where(eq(schema.aiTool.id, toolId))
      .limit(1);
    if (!t?.secret || !d.ownTools) return null;
    return decryptSecretJson<ToolSecret>(t.secret, d.ownTools.secretKey);
  }

  async function logToolCall(row: Omit<typeof schema.aiToolCall.$inferInsert, "id">) {
    await db
      .insert(schema.aiToolCall)
      .values({ id: newId("aiToolCall"), ...row, error: row.error?.slice(0, 500) ?? null })
      .onConflictDoNothing()
      .catch((err) => console.warn("[agent] tool call not logged:", (err as Error).message));
  }

  /** The tools for one turn, bound to this business and chat. */
  function agentTools(agent: LoadedAgent, runCtx: RunContext) {
    return [...builtinAgentTools(agent, runCtx), ...ownTools(agent)];
  }

  /** Booking for this chat: free times, booking after a Yes, and the customer's own bookings. */
  function bookingDeps(agent: LoadedAgent, runCtx: RunContext): BookingDeps | undefined {
    const setup = agent.booking;
    if (!setup || !runCtx.conversationId) return undefined;
    const tz = setup.timezone;
    // When the customer's number says they live in another timezone, the tools speak only in theirs
    // (the times they show and the times they take), and the code converts to the branch's both
    // ways. The model never converts a time itself, so it can't get one wrong.
    const zone = runCtx.customerZone && runCtx.customerZone.timezone !== tz ? runCtx.customerZone : null;
    const theirTz = zone?.timezone ?? tz;
    const ourPlace = timezonePlace(tz);
    const org = { organizationId: runCtx.orgId, branchId: runCtx.branchId };
    const startOf = (date: string, time: string) =>
      zonedTime(date, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)), theirTz);
    const note = (key: string, text: string) =>
      addNoteIn(runCtx.conversationId as string, agent.id, `booking:${key}`, text);
    const shown = (b: {
      reference: string;
      title: string;
      startsAt: Date;
      endsAt?: Date;
      status: string;
      partySize: number | null;
      meetUrl?: string | null;
    }) => ({
      reference: b.reference,
      service: b.title,
      when: bookingTimeLabel(b.startsAt, theirTz),
      ...(b.endsAt
        ? { time: `${bookingRangeLabel(b.startsAt, b.endsAt, theirTz)} ${zone?.place ?? ourPlace} time` }
        : {}),
      ...(b.endsAt && zone
        ? { ourTime: `${bookingRangeLabel(b.startsAt, b.endsAt, tz)} ${ourPlace} time` }
        : {}),
      ...(b.partySize ? { people: b.partySize } : {}),
      ...(b.meetUrl ? { meetLink: b.meetUrl } : {}),
      status: b.status,
    });
    const mine = async (reference: string) => {
      if (!runCtx.contactId) return null;
      const all = await upcomingBookingsFor(db, {
        organizationId: runCtx.orgId,
        contactId: runCtx.contactId,
        now: new Date(),
      });
      return all.find((b) => b.reference.toUpperCase() === reference.trim().toUpperCase()) ?? null;
    };
    return {
      timezone: zone ? `the customer's own time (${zone.place}, ${theirTz})` : tz,
      services: setup.services,
      findTimes: async ({ variantId, date, partOfDay }) => {
        const res = await agentFreeTimes(db, {
          calendar: d.calendar ?? null,
          ...org,
          variantId,
          timezone: theirTz,
          ...(date ? { date } : {}),
          ...(partOfDay ? { partOfDay } : {}),
          now: new Date(),
        });
        if (!zone || !("times" in res) || !res.times) return res;
        return {
          ...res,
          timesAre: `${zone.place} time, the customer's own`,
          times: res.times.map((t) => ({
            ...t,
            ourTime: `${bookingTimeLabel(startOf(t.date, t.time), tz)} ${ourPlace} time`,
          })),
        };
      },
      book: async ({ variantId, date, time, partySize, notes }) => {
        const res = await createBooking(db, {
          calendar: d.calendar ?? null,
          id: newId("booking"),
          ...org,
          variantId,
          startsAt: startOf(date, time),
          contactId: runCtx.contactId,
          conversationId: runCtx.conversationId,
          partySize: partySize ?? null,
          notes: notes ?? "",
          bookedBy: "ai",
          now: new Date(),
        });
        if (!res.ok) throw new Error(`${bookingProblem[res.reason]} Offer other times with find_times.`);
        await note(
          `${res.booking.id}:booked`,
          `${agent.name} booked ${res.booking.title} for ${res.label}${res.booking.partySize ? ` (${res.booking.partySize} people)` : ""}. Reference ${res.booking.reference}.`,
        );
        return { booked: true, ...shown({ ...res.booking, meetUrl: res.meetUrl }) };
      },
      myBookings: async () => {
        if (!runCtx.contactId) return { bookings: [] };
        const all = await upcomingBookingsFor(db, {
          organizationId: runCtx.orgId,
          contactId: runCtx.contactId,
          now: new Date(),
        });
        return { bookings: all.map(shown) };
      },
      move: async ({ reference, date, time }) => {
        const b = await mine(reference);
        if (!b) throw new Error("No upcoming booking of this customer has that reference. Use my_bookings.");
        const res = await moveBooking(db, {
          calendar: d.calendar ?? null,
          organizationId: runCtx.orgId,
          bookingId: b.id,
          startsAt: startOf(date, time),
          now: new Date(),
          ...(runCtx.contactId ? { contactId: runCtx.contactId } : {}),
        });
        if (!res.ok) throw new Error(`${bookingProblem[res.reason]} Offer other times with find_times.`);
        await note(
          `${b.id}:moved:${res.booking.startsAt.toISOString()}`,
          `${agent.name} moved ${res.booking.title} (${res.booking.reference}) from ${bookingTimeLabel(b.startsAt, tz)} to ${res.label}.`,
        );
        return { moved: true, ...shown({ ...res.booking, meetUrl: res.meetUrl }) };
      },
      cancel: async ({ reference }) => {
        const b = await mine(reference);
        if (!b) throw new Error("No upcoming booking of this customer has that reference. Use my_bookings.");
        const row = await setBookingStatus(db, {
          calendar: d.calendar ?? null,
          organizationId: runCtx.orgId,
          bookingId: b.id,
          status: "cancelled",
          ...(runCtx.contactId ? { contactId: runCtx.contactId } : {}),
        });
        if (!row) throw new Error("That booking wasn't found.");
        await note(
          `${b.id}:cancelled`,
          `${agent.name} cancelled ${b.title} on ${bookingTimeLabel(b.startsAt, tz)} (${b.reference}).`,
        );
        return { cancelled: true, ...shown(row) };
      },
      invite: async ({ reference, email }) => {
        const b = await mine(reference);
        if (!b) throw new Error("No upcoming booking of this customer has that reference. Use my_bookings.");
        const added = cleanGuestEmails([email])?.[0];
        if (!added) throw new Error("That isn't an email address. Ask the customer to check it.");
        const guestEmails = cleanGuestEmails([...b.guestEmails, added]) ?? b.guestEmails;
        if (guestEmails.length > maxBookingGuests)
          throw new Error(`A booking can have at most ${maxBookingGuests} people invited.`);
        const res = await saveBookingGuests(db, {
          calendar: d.calendar ?? null,
          organizationId: runCtx.orgId,
          bookingId: b.id,
          guestEmails,
          ...(runCtx.contactId ? { contactId: runCtx.contactId } : {}),
        });
        if (!res) throw new Error("That booking can't be changed any more.");
        await note(
          `${b.id}:invited:${added}`,
          `${agent.name} invited ${added} to ${b.title} (${b.reference}).`,
        );
        if (res.sync.status === "skipped")
          return {
            invited: false,
            email: added,
            reason:
              "This business's bookings aren't in a calendar, so no invite can be emailed. Give the booking details here in the chat instead.",
          };
        return {
          invited: true,
          email: added,
          ...(res.sync.status === "failed"
            ? {
                note: "The calendar didn't answer yet; the invite goes out as soon as it does, usually within minutes.",
              }
            : {}),
          ...shown({ ...res.booking, meetUrl: res.sync.meetUrl ?? res.booking.meetUrl }),
        };
      },
    };
  }

  /** The follow-up tool: adds a task to the branch's Google Tasks and notes it in the chat. */
  function taskDeps(agent: LoadedAgent, runCtx: RunContext) {
    return {
      add: async (input: FollowUpInput) => {
        const r = await addFollowUp(agent, {
          organizationId: runCtx.orgId,
          branchId: runCtx.branchId,
          conversationId: runCtx.conversationId as string,
          contactId: runCtx.contactId,
          title: input.title,
          details: input.details,
          due: input.due,
          source: "agent",
          now: runCtx.now,
        });
        return r.ok
          ? { added: true, title: input.title, due: r.due, ...(r.reused ? { alreadyAdded: true } : {}) }
          : {
              added: false,
              problem: r.message,
              hint: "Tell the customer the team will follow up. Hand over if it's urgent.",
            };
      },
    };
  }

  /**
   * One follow-up in Google Tasks, once: the same chat, day and title make the same task, so a
   * retried step or a repeated call doesn't add a second one. The chat gets a note either way.
   */
  async function addFollowUp(
    agent: LoadedAgent,
    t: {
      organizationId: string;
      branchId: string;
      conversationId: string;
      contactId: string | null;
      title: string;
      details: string;
      due: string | undefined;
      source: "agent" | "handoff";
      now: Date;
    },
  ): Promise<{ ok: true; due: string | null; reused: boolean } | { ok: false; message: string }> {
    const deps = d.calendar;
    const tz = agent.tasks?.timezone ?? "UTC";
    if (!deps) return { ok: false, message: "Google isn't set up on this server." };
    const dueDate = taskDueDate(t.due, t.now, tz);
    const [c] = t.contactId
      ? await db
          .select({ name: schema.contact.name, phone: schema.contact.phone })
          .from(schema.contact)
          .where(eq(schema.contact.id, t.contactId))
          .limit(1)
      : [];
    const notes = [
      t.details.trim(),
      "",
      `Customer: ${[c?.name, c?.phone ? `+${c.phone}` : null].filter(Boolean).join(", ") || "unknown"}`,
      `Chat: ${deps.appUrl.replace(/\/$/, "")}/conversations?view=all&c=${t.conversationId}`,
      `Added by ${agent.name} from WhatsApp.`,
    ].join("\n");
    const day = localTime(t.now, tz).date;
    const hash = createHash("sha1").update(t.title.trim().toLowerCase()).digest("hex").slice(0, 12);
    const key = `${t.conversationId}:${day}:${hash}`;
    const r = await addFollowUpTask(db, deps, key, {
      organizationId: t.organizationId,
      branchId: t.branchId,
      agentId: agent.id,
      conversationId: t.conversationId,
      title: t.title.trim(),
      notes,
      dueDate,
      source: t.source,
    });
    const due = dueDate ? taskDueLabel(dueDate) : null;
    if (r.ok && !r.reused)
      await addNoteIn(
        t.conversationId,
        agent.id,
        `task:${key}`,
        `Follow-up added to Google Tasks: ${t.title.trim()}${due ? ` (due ${due})` : ""}.`,
      );
    if (!r.ok)
      await addNoteIn(
        t.conversationId,
        agent.id,
        `task:${key}:failed`,
        `${agent.name} couldn't add a follow-up to Google Tasks (${r.message}). To do: ${t.title.trim()}${due ? `, by ${due}` : ""}.`,
      );
    return r.ok ? { ok: true, due, reused: r.reused } : { ok: false, message: r.message };
  }

  function builtinAgentTools(agent: LoadedAgent, runCtx: RunContext) {
    const embedCatalog = d.embedCatalog;
    const booking = bookingDeps(agent, runCtx);
    const tasks = agent.tasks?.enabled && runCtx.conversationId ? taskDeps(agent, runCtx) : null;
    return builtinTools({
      ...(booking ? { booking } : {}),
      ...(tasks ? { tasks } : {}),
      editableFields: agent.editableFields,
      ...(agent.catalog
        ? {
            catalog: catalogAgentDeps(db, {
              organizationId: runCtx.orgId,
              branchId: runCtx.branchId,
              shape: agent.catalog,
              embed: embedCatalog ? async (text) => (await embedCatalog([text])).embeddings[0] ?? null : null,
              terms: searchTerms,
            }),
          }
        : {}),
      searchKnowledge: async (query) => {
        const embedding = d.embed ? ((await d.embed([query])).embeddings[0] ?? null) : null;
        const hits = await searchKnowledge(db, {
          orgId: runCtx.orgId,
          branchId: runCtx.branchId,
          terms: searchTerms(query),
          embedding,
        });
        return hits.map((h) => ({ source: h.title, text: h.content }));
      },
      // An empty search is not yet a gap: the agent may search again or answer from the chat. Saying it
      // can't answer (cant_answer) is what records the question.
      updateContact: async (change) => {
        if (!runCtx.contactId) return { saved: [] };
        const saved: string[] = [];
        const c = schema.contact;
        if (Object.keys(change.fields).length) {
          await db
            .update(c)
            .set({
              attributes: sql`${c.attributes} || ${JSON.stringify(change.fields)}::jsonb`,
              updatedAt: new Date(),
            })
            .where(and(eq(c.id, runCtx.contactId), eq(c.organizationId, runCtx.orgId)));
          saved.push(...Object.keys(change.fields));
        }
        if (change.addTags.length) {
          const tags = await db
            .select({ id: schema.tag.id, name: schema.tag.name })
            .from(schema.tag)
            .where(
              and(
                eq(schema.tag.organizationId, runCtx.orgId),
                inArray(
                  sql`lower(${schema.tag.name})`,
                  change.addTags.map((t) => t.toLowerCase()),
                ),
                sql`(${schema.tag.branchId} is null or ${schema.tag.branchId} = ${runCtx.branchId})`,
              ),
            );
          if (tags.length) {
            await db
              .update(c)
              .set({
                tagIds: sql`(select array(select distinct unnest(${c.tagIds} || array[${sql.join(
                  tags.map((t) => sql`${t.id}`),
                  sql`, `,
                )}]::text[])))`,
                updatedAt: new Date(),
              })
              .where(and(eq(c.id, runCtx.contactId), eq(c.organizationId, runCtx.orgId)));
            saved.push(...tags.map((t) => `tag:${t.name}`));
          }
        }
        return { saved };
      },
    });
  }

  // ------------------------------------------------------------------ reading the chat

  /** The buttons or list rows of one of our messages (empty for anything else). */
  function optionsOf(content: Record<string, unknown>): { id: string; title: string }[] {
    const options = content.options;
    if (!Array.isArray(options)) return [];
    return options.filter(
      (o): o is { id: string; title: string } => typeof o?.id === "string" && typeof o?.title === "string",
    );
  }

  /** The last 40 readable messages, oldest first, as the model sees them. */
  async function chatLines(
    conversationId: string,
    { hears, sees }: { hears: boolean; sees: boolean },
  ): Promise<ChatLine[]> {
    const m = schema.message;
    const rows = await db
      .select({
        id: m.id,
        direction: m.direction,
        senderType: m.senderType,
        type: m.type,
        content: m.content,
        sentAt: m.sentAt,
        replyTo: m.replyToMessageId,
      })
      .from(m)
      .where(and(eq(m.conversationId, conversationId), ne(m.type, "reaction"), ne(m.type, "note")))
      .orderBy(desc(m.sentAt), desc(m.id))
      .limit(40);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lines: ChatLine[] = [];
    for (const r of rows.reverse()) {
      const content = r.content as Record<string, unknown>;
      let text = previewText(content);
      if (!text) text = r.type === "text" ? "" : `[${r.type}]`;
      if (r.type === "audio")
        text = voiceNoteLine(content, r.direction === "inbound" ? "customer" : "us", hears);
      if (r.type === "image") text = photoLine(content, r.direction === "inbound" ? "customer" : "us", sees);
      if (r.type === "location" && content.latitude) text = `[shared a location: ${text ?? ""}]`.trim();
      const asked = content.pendingAction as PendingAction | undefined;
      if (r.direction === "outbound" && asked)
        text = `[asked the customer to tap Yes or No: "${asked.question}"${asked.answer ? `; they tapped ${asked.answer === "yes" ? "Yes" : "No"}` : "; waiting for a tap on Yes"}]`;
      // Our buttons or list: say which choices we gave, so a tap on one is known to be one we offered
      // (otherwise the model can't tell, checks again and offers the times a second time).
      const offered = optionsOf(content);
      if (r.direction === "outbound" && !asked && offered.length)
        text = [text, `[gave choices: ${offered.map((o) => o.title).join("; ")}]`].filter(Boolean).join("\n");
      // A tap on one of our item cards: say which item, so "Order" means something. Reply buttons
      // come back with the id as `id`; carousel buttons as a "button" message with it as `payload`.
      const tapId =
        typeof content.id === "string"
          ? content.id
          : typeof content.payload === "string"
            ? content.payload
            : null;
      if (r.direction === "inbound" && r.replyTo && tapId) {
        const repliedTo = byId.get(r.replyTo)?.content as Record<string, unknown> | undefined;
        if (repliedTo && !repliedTo.pendingAction && optionsOf(repliedTo).some((o) => o.id === tapId))
          text = `[picked "${text}" from the choices we gave]`;
        const n = optionOfReply(tapId)?.match(/^i(\d{1,2})[mobs]$/)?.[1];
        const items = (
          byId.get(r.replyTo)?.content as { items?: { id: string; title: string }[] } | undefined
        )?.items;
        const item = n !== undefined ? items?.[Number(n)] : undefined;
        if (item) text = `[tapped "${text}" on ${item.title} (${item.id})]`;
        const remindedOf = (byId.get(r.replyTo)?.content as { booking?: { reference: string } } | undefined)
          ?.booking;
        if (bookingReplyOf(tapId) && remindedOf)
          text = `[tapped "${text}" on the reminder for booking ${remindedOf.reference}]`;
      }
      if (!text) continue;
      const from: ChatLine["from"] =
        r.direction === "inbound" ? "customer" : r.senderType === "user" ? "team" : "agent";
      lines.push({ from, text, at: r.sentAt });
    }
    return lines;
  }

  async function contactFacts(contactId: string, agent: LoadedAgent): Promise<ContactFacts> {
    const [c] = await db.select().from(schema.contact).where(eq(schema.contact.id, contactId)).limit(1);
    if (!c) return {};
    const attrs = (c.attributes ?? {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const f of agent.editableFields) if (attrs[f.key] != null) fields[f.label] = String(attrs[f.key]);
    const tags = c.tagIds.length
      ? (
          await db.select({ name: schema.tag.name }).from(schema.tag).where(inArray(schema.tag.id, c.tagIds))
        ).map((t) => t.name)
      : [];
    return { name: c.name, fields, tags };
  }

  async function branchTimezone(branchId: string): Promise<string> {
    const [b] = await db
      .select({ timezone: schema.branch.timezone })
      .from(schema.branch)
      .where(eq(schema.branch.id, branchId))
      .limit(1);
    return b?.timezone || "UTC";
  }

  // ------------------------------------------------------------------ side effects (inside steps)

  type Sent = { ok: true; messageId: string } | { ok: false; reason: string };

  async function queueSend(
    input: AgentRunInput,
    agent: LoadedAgent,
    stepKey: string,
    type: string,
    content: Record<string, unknown>,
    attachmentId?: string,
  ): Promise<Sent> {
    const conv = await conversationOf(input.conversationId);
    if (!conv) return { ok: false, reason: "chat_gone" };
    const [account] = await db
      .select({ status: schema.channelAccount.status })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, conv.channelAccountId))
      .limit(1);
    if (account?.status !== "active") return { ok: false, reason: "channel_inactive" };
    if (!conv.windowExpiresAt || conv.windowExpiresAt <= new Date())
      return { ok: false, reason: "window_closed" };
    const { message } = await insertOutboundMessage(db, {
      id: newId("message"),
      conversation: conv,
      type,
      content: { ...content, aiAgentId: agent.id },
      senderType: "ai_agent",
      senderName: agent.name,
      automationStepKey: stepKey,
      ...(attachmentId ? { attachmentId } : {}),
    });
    if (message.status === "queued") {
      await Promise.race([
        d.outbox.add("send", { messageId: message.id }, { jobId: message.id, ...d.outboxJobOptions }),
        new Promise((r) => setTimeout(r, 5_000)),
      ]).catch(() => {});
    }
    await announce(conv);
    return { ok: true, messageId: message.id };
  }

  /** Sends as the agent, for the catalogue presenter. */
  const sender =
    (input: AgentRunInput, agent: LoadedAgent) =>
    (key: string, type: string, content: Record<string, unknown>, attachmentId?: string) =>
      queueSend(input, agent, key, type, content, attachmentId);

  const sendText = (input: AgentRunInput, agent: LoadedAgent, stepKey: string, text: string) =>
    queueSend(input, agent, stepKey, "text", { type: "text", text });

  /**
   * A plain reply: a voice note when the agent's Voice replies setting asks for one (always, or when
   * the customer's last message was a voice note), otherwise text. Anything that stops the voice note
   * (no credits, a language the voice can't speak, the speech service failing) sends text instead.
   */
  async function sendReply(input: AgentRunInput, agent: LoadedAgent, stepKey: string, text: string) {
    const mode = agent.voiceReplies ?? "off";
    if (
      d.voiceReplies &&
      mode !== "off" &&
      text.length <= voiceReplyLimits.maxCharacters &&
      (mode === "always" || (await customersLastWasVoice(input.conversationId)))
    ) {
      try {
        const sent = await sendVoiceReply(input, agent, stepKey, text);
        if (sent) return sent;
      } catch (err) {
        console.warn("[agent] voice reply failed, sending text:", (err as Error).message);
      }
    }
    return sendText(input, agent, stepKey, text);
  }

  async function customersLastWasVoice(conversationId: string) {
    const m = schema.message;
    const [last] = await db
      .select({ type: m.type })
      .from(m)
      .where(and(eq(m.conversationId, conversationId), eq(m.direction, "inbound"), ne(m.type, "reaction")))
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(1);
    return last?.type === "audio";
  }

  /** Speaks the reply and sends it as a voice note (plus the text when it has links or long numbers). */
  async function sendVoiceReply(
    input: AgentRunInput,
    agent: LoadedAgent,
    stepKey: string,
    text: string,
  ): Promise<Sent | null> {
    const v = d.voiceReplies;
    if (!v) return null;
    const language = speechLanguage(text);
    const { say, alsoAsText } = speechText(text);
    if (!language || !say) return null;
    if ((await aiCredits(db, input.organizationId, defaultMonthlyCredits)).left < voiceReplyLimits.credits)
      return null;
    const started = Date.now();
    const spoken = await v.speak(say, language);
    const note = await (v.encode ?? toVoiceNote)(spoken.audio);
    const { file } = await storeFile(db, v.storage, {
      organizationId: input.organizationId,
      bytes: note.bytes,
      mimeType: "audio/ogg",
      newId: () => newId("storedFile"),
      quota: "count",
    });
    const attachmentId = newId("attachment");
    await db.insert(schema.attachment).values({
      id: attachmentId,
      organizationId: input.organizationId,
      kind: "audio",
      mimeType: "audio/ogg",
      fileName: "voice-note.ogg",
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      fileId: file.id,
      storageKey: file.storageKey,
      status: "stored",
    });
    const sent = await queueSend(
      input,
      agent,
      stepKey,
      "audio",
      {
        type: "audio",
        voice: true,
        caption: null,
        // What was said, for the agent's own history and under the player in the inbox.
        transcript: text,
        ...(note.seconds ? { transcriptSeconds: Math.round(note.seconds) } : {}),
        media: {
          providerMediaId: null,
          mimeType: "audio/ogg",
          fileName: "voice-note.ogg",
          sha256: file.sha256,
          caption: null,
        },
      },
      attachmentId,
    );
    if (!sent.ok) return sent;
    await recordAiUsage(db, {
      id: newId("aiUsage"),
      organizationId: input.organizationId,
      branchId: input.branchId,
      agentId: agent.id,
      conversationId: input.conversationId,
      runId: stepKey.split(":")[0] ?? null,
      stepKey: `${stepKey}:speak`,
      kind: "speech",
      model: spoken.model,
      costMicros: speechCostMicros(spoken.characters),
      credits: voiceReplyLimits.credits,
      latencyMs: Date.now() - started,
    });
    if (alsoAsText) await sendText(input, agent, `${stepKey}:text`, text);
    return sent;
  }

  function sendOptions(
    input: AgentRunInput,
    agent: LoadedAgent,
    stepKey: string,
    o: Extract<TurnOutcome, { kind: "options" }>,
  ) {
    return queueSend(input, agent, stepKey, "interactive", {
      type: "interactive",
      kind: o.options.length <= 3 ? "buttons" : "list",
      body: o.text,
      buttonText: o.buttonText || "Choose",
      options: o.options.map((opt) => ({
        id: optionReplyId(stepKey, opt.id),
        title: opt.title.slice(0, 24),
      })),
    });
  }

  /** The agent's "shall I go ahead?" question for a change in the business's system, with Yes / No. */
  function sendConfirm(
    input: AgentRunInput,
    agent: LoadedAgent,
    stepKey: string,
    o: Extract<TurnOutcome, { kind: "confirm" }>,
  ) {
    const pendingAction: PendingAction = {
      toolId: o.toolId,
      toolName: o.toolName,
      ...(o.mcpTool ? { mcpTool: o.mcpTool } : {}),
      title:
        o.toolId === bookingToolRef.toolId
          ? bookingToolRef.title
          : (agent.tools?.find((t) => t.id === o.toolId)?.title ?? o.toolName),
      input: o.input,
      question: o.text,
      expiresAt: new Date(Date.now() + agentToolLimits.confirmMinutes * 60_000).toISOString(),
    };
    return queueSend(input, agent, stepKey, "interactive", {
      type: "interactive",
      kind: "buttons",
      body: o.text,
      buttonText: "Choose",
      options: [
        { id: optionReplyId(stepKey, "yes"), title: "Yes" },
        { id: optionReplyId(stepKey, "no"), title: "No" },
      ],
      pendingAction,
    });
  }

  /** A Yes / No tap on one of those questions (null for any other tap). */
  async function confirmTapOf(messageId: string, replyId: string) {
    const answer = optionOfReply(replyId);
    if (answer !== "yes" && answer !== "no") return null;
    const rows = (await db.execute(sql`
      select b.id, b.content from message t join message b on b.id = t.reply_to_message_id
      where t.id = ${messageId} limit 1`)) as unknown as {
      id: string;
      content: { pendingAction?: PendingAction };
    }[];
    const pending = rows[0]?.content.pendingAction;
    return pending && rows[0] ? { answer, questionId: rows[0].id, pending } : null;
  }

  /**
   * Carries out a tapped Yes (or records a No), at most once per question, and says what happened in
   * a note for the model. Runs inside the turn's `act` step.
   */
  async function carryOut(
    input: AgentRunInput,
    agent: LoadedAgent,
    tap: NonNullable<Awaited<ReturnType<typeof confirmTapOf>>>,
  ): Promise<string> {
    const { pending, answer } = tap;
    const q = `"${pending.question}"`;
    const claimed = (await db.execute(sql`
      update message
      set content = jsonb_set(content, '{pendingAction}',
        (content->'pendingAction') || ${JSON.stringify({ doneAt: new Date().toISOString(), answer })}::jsonb)
      where id = ${tap.questionId} and content->'pendingAction'->>'doneAt' is null
      returning id`)) as unknown as { id: string }[];
    if (!claimed.length)
      return `The customer tapped ${answer === "yes" ? "Yes" : "No"} again on ${q}, which was already answered. Nothing more was done.`;
    if (answer === "no") {
      if (!pending.toolId.startsWith("builtin:"))
        await logToolCall({
          organizationId: input.organizationId,
          agentId: agent.id,
          toolId: pending.toolId,
          conversationId: input.conversationId,
          name: pending.toolName,
          mode: "live",
          status: "declined",
        });
      return `The customer tapped No to ${q}, so it was not done. Ask what they'd like instead.`;
    }
    if (new Date(pending.expiresAt) < new Date())
      return `The customer tapped Yes to ${q}, but more than ${agentToolLimits.confirmMinutes} minutes after it was asked, so nothing was done. If they still want it, ask again.`;
    const runCtx = await liveContext(input, agent);
    // Built-in tools (booking) by name; the business's own by which tool (names follow titles).
    const tool = agentTools(agent, runCtx).find((t) =>
      pending.toolId.startsWith("builtin:")
        ? t.name === pending.toolName
        : t.ref?.toolId === pending.toolId && (t.ref.mcpTool ?? null) === (pending.mcpTool ?? null),
    );
    if (!tool)
      return `The customer tapped Yes to ${q}, but ${pending.title} isn't available any more, so nothing was done. Offer a person from the team.`;
    const args = { ...(pending.input as Record<string, unknown>), confirmText: pending.question };
    const result = await runTool(tool, args, runCtx);
    if (!result.ok)
      return `The customer tapped Yes to ${q}. It was tried but didn't go through: ${result.error.slice(0, 400)} Tell them plainly and offer a person from the team.`;
    return `The customer tapped Yes to ${q}, and it was carried out just now. Its result: ${JSON.stringify(envelope(result)).slice(0, 6000)} Tell the customer how it went, using only this result.`;
  }

  async function addNote(input: AgentRunInput, agent: LoadedAgent, stepKey: string, text: string) {
    await addNoteIn(input.conversationId, agent.id, stepKey, text);
  }

  /** A note in the chat for the team (once per key). */
  async function addNoteIn(conversationId: string, agentId: string, stepKey: string, text: string) {
    const conv = await conversationOf(conversationId);
    if (!conv) return;
    await db
      .insert(schema.message)
      .values({
        id: newId("message"),
        organizationId: conv.organizationId,
        conversationId: conv.id,
        channelAccountId: conv.channelAccountId,
        direction: "outbound",
        senderType: "ai_agent",
        type: "note",
        content: { type: "note", text, mentions: [], aiAgentId: agentId },
        status: "sent",
        automationStepKey: `${stepKey}:note`,
        sentAt: new Date(),
      })
      .onConflictDoNothing();
  }

  /** A question the agent couldn't answer, for "Improve" (once per step). */
  async function noteGap(input: AgentRunInput, agent: LoadedAgent, stepKey: string, question: string) {
    await db
      .insert(schema.aiGap)
      .values({
        id: newId("aiGap"),
        organizationId: input.organizationId,
        branchId: input.branchId,
        agentId: agent.id,
        conversationId: input.conversationId,
        stepKey,
        question: question.slice(0, 500),
      })
      .onConflictDoNothing();
  }

  /** Steps back for a person: says so to the customer, leaves a note for the team, assigns the chat. */
  async function handOver(
    input: AgentRunInput,
    agent: LoadedAgent,
    stepKey: string,
    o: Extract<TurnOutcome, { kind: "handoff" }>,
  ) {
    if (o.text) await sendText(input, agent, stepKey, o.text);
    // The customer always hears that a person is coming, even if the business cleared the message.
    const bye = agent.handoff.message.trim() || (o.text ? "" : agentHandoffSchema.parse({}).message);
    if (bye) await sendText(input, agent, `${stepKey}:bye`, bye);
    await addNote(input, agent, stepKey, `${agent.name} handed this chat over: ${o.reason}.\n${o.summary}`);
    // "Also add a task whenever Mira hands a chat to the team" (Google Tasks).
    if (agent.tasks?.onHandoff)
      await addFollowUp(agent, {
        organizationId: input.organizationId,
        branchId: input.branchId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        title: `Reply on WhatsApp: ${o.reason}`.slice(0, 120),
        details: o.summary,
        due: "today",
        source: "handoff",
        now: new Date(),
      }).catch((err) => console.warn(`[tasks] hand-over task failed: ${(err as Error).message}`));
    const [c] = await db
      .update(schema.conversation)
      .set({
        status: "open",
        ...(agent.handoff.assignToUserId ? { assignedUserId: agent.handoff.assignToUserId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.conversation.id, input.conversationId))
      .returning();
    if (c) await announce(c);
  }

  async function closeChat(
    input: AgentRunInput,
    agent: LoadedAgent,
    stepKey: string,
    o: Extract<TurnOutcome, { kind: "close" }>,
  ) {
    if (o.text) await sendText(input, agent, stepKey, o.text);
    const [c] = await db
      .update(schema.conversation)
      .set({ status: "closed", updatedAt: new Date() })
      .where(eq(schema.conversation.id, input.conversationId))
      .returning();
    if (c) await announce(c);
  }

  return { run, startRun, canTake, maybeStartUnclaimed, release };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
