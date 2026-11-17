import {
  type AgentProfile,
  builtinTools,
  type ChatLine,
  type ContactFacts,
  chatMessages,
  contextNote,
  costMicros,
  creditsFor,
  defaultMonthlyCredits,
  type Embedder,
  type ModelCaller,
  modelFor,
  type RunContext,
  runTurn,
  searchTerms,
  systemPrompt,
  type TurnOutcome,
} from "@relay/agent";
import { newId, type Publisher, previewText, publishInboxEvent } from "@relay/core";
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
  aiCredits,
  and,
  catalogAgentDeps,
  catalogShape,
  createCatalogPresenter,
  type createDb,
  desc,
  eq,
  inArray,
  insertOutboundMessage,
  ne,
  recordAiUsage,
  schema,
  searchKnowledge,
  sql,
  sqlExecutor,
} from "@relay/db";
import { isKairosControl, type Kairos, type RunRow, type WorkflowContext } from "@relay/kairos";
import type { Queue } from "bullmq";

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
    if (!withinAgentHours(agent.hours)) return { action: "none", reason: "outside_hours" };
    const [last] = await kairos.listRuns({
      workflow: agentWorkflow.name,
      labels: { conversationId: conv.id },
      limit: 1,
    });
    const recent = last?.finished_at && Date.now() - new Date(last.finished_at).getTime() < 24 * 3_600_000;
    const handedOver = (last?.output as { ended?: Ended } | null)?.ended === "handoff";
    if (recent && (handedOver || last?.status === "cancelled"))
      return { action: "none", reason: handedOver ? "recently_handed_over" : "team_took_over" };
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
    return {
      id: a.id,
      status: a.status,
      name: a.name,
      model: a.model,
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
      } satisfies AgentProfile,
      editableFields: fields,
      /** What the branch sells (null: no catalogue tools). Frozen for the run like the rest. */
      catalog,
    };
  }
  type LoadedAgent = NonNullable<Awaited<ReturnType<typeof loadAgent>>> & {
    /** The chat's last message was already ours (an automation answered the trigger before handing over). */
    triggerAnswered?: boolean;
  };

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
      pending = false;
      // Several quick messages ("hi" / "price?" / "for 2") make one answer.
      for (let k = 0; k < agentLimits.gatherMax; k++) {
        const name = `t${turn}:more${k}`;
        const more = await ctx.waitForEvent<InboundEventPayload>(name, {
          key,
          scope,
          timeoutMs: agentLimits.gatherMs,
          lookbackFrom,
        });
        if (more.timedOut) break;
        if (more.event.payload.optOut === "stop") return "stopped";
        latest = more.event.payload;
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
      const now = await ctx.step(`t${turn}:live`, async (): Promise<LoadedAgent | false> => {
        const fresh = await loadAgent(agent.id, input.organizationId);
        return fresh?.status === "live" ? fresh : false;
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
      const typingStep = `t${turn}:typing`;
      await ctx.step(typingStep, () => d.showTyping(input.conversationId, `${ctx.runId}_t${turn}`));
      const outcome = await oneTurn(ctx, input, agent, turn);
      lookbackFrom = typingStep;
      const stepKey = `${ctx.runId}:t${turn}`;
      switch (outcome.kind) {
        case "silent":
          break;
        case "reply": {
          const sent = await ctx.step(`t${turn}:send`, () => sendText(input, agent, stepKey, outcome.text));
          if (!sent.ok) return "send_failed";
          if (outcome.gap) {
            const question = outcome.gap;
            await ctx.step(`t${turn}:gap`, () => noteGap(input, agent, `${stepKey}:gap`, question));
          }
          break;
        }
        case "options": {
          const sent = await ctx.step(`t${turn}:send`, () => sendOptions(input, agent, stepKey, outcome));
          if (!sent.ok) return "send_failed";
          break;
        }
        case "items": {
          const sent = await ctx.step(`t${turn}:send`, () =>
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
          break;
        }
        case "media": {
          const sent = await ctx.step(`t${turn}:send`, () =>
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
          break;
        }
        case "handoff":
          await ctx.step(`t${turn}:handoff`, () => handOver(input, agent, stepKey, outcome));
          return "handoff";
        case "close":
          await ctx.step(`t${turn}:close`, () => closeChat(input, agent, stepKey, outcome));
          return "close";
      }
    }
  }

  /** One answer: check credits, build the prompt from the chat, run the bounded tool loop. */
  async function oneTurn(
    ctx: WorkflowContext,
    input: AgentRunInput,
    agent: LoadedAgent,
    turn: number,
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

    const [lines, contact] = await Promise.all([
      chatLines(input.conversationId),
      contactFacts(input.contactId, agent),
    ]);
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
    const tools = agentTools(agent, runCtx);
    try {
      const result = await runTurn({
        model: modelFor(agent.model),
        system: systemPrompt(agent.profile),
        messages: chatMessages(lines, contextNote(runCtx, contact, agent.profile.languages)),
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

  /** The tools for one turn, bound to this business and chat. */
  function agentTools(agent: LoadedAgent, runCtx: RunContext) {
    const embedCatalog = d.embedCatalog;
    return builtinTools({
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

  /** The last 40 readable messages, oldest first, as the model sees them. */
  async function chatLines(conversationId: string): Promise<ChatLine[]> {
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
      if (r.type === "location" && content.latitude) text = `[shared a location: ${text ?? ""}]`.trim();
      // A tap on one of our item cards: say which item, so "Order" means something. Reply buttons
      // come back with the id as `id`; carousel buttons as a "button" message with it as `payload`.
      const tapId =
        typeof content.id === "string"
          ? content.id
          : typeof content.payload === "string"
            ? content.payload
            : null;
      if (r.direction === "inbound" && r.replyTo && tapId) {
        const n = optionOfReply(tapId)?.match(/^i(\d{1,2})[mobs]$/)?.[1];
        const items = (
          byId.get(r.replyTo)?.content as { items?: { id: string; title: string }[] } | undefined
        )?.items;
        const item = n !== undefined ? items?.[Number(n)] : undefined;
        if (item) text = `[tapped "${text}" on ${item.title} (${item.id})]`;
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

  async function addNote(input: AgentRunInput, agent: LoadedAgent, stepKey: string, text: string) {
    const conv = await conversationOf(input.conversationId);
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
        content: { type: "note", text, mentions: [], aiAgentId: agent.id },
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

  return { run, startRun, maybeStartUnclaimed, release };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
