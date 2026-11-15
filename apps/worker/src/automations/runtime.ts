import type { ChannelType } from "@relay/channels";
import { newId, type Publisher, publishInboxEvent, type SignalJob } from "@relay/core";
import {
  type AskQuestionConfig,
  type AutomationDefinition,
  type AutomationNode,
  type AutomationRunInput,
  type AutomationRunLabels,
  askLayout,
  automationEvents,
  automationWorkflows,
  type ConditionConfig,
  type InboundEventPayload,
  LIMITS,
  migrateDefinition,
  nodeSpec,
  optionFromReply,
  optionOfReply,
  optionReplyId,
  parseStepKey,
  pickAutomation,
  resolveText,
  type SendMessageConfig,
  type SendTemplateConfig,
  type TapTarget,
  tapTarget,
  typingPauseMs,
  type VariableScope,
  type WaitConfig,
} from "@relay/core/automations";
import { type TemplateContent, templateMessageContent, templateVariables } from "@relay/core/templates";
import {
  activeFields,
  and,
  compileFilter,
  type createDb,
  eq,
  inArray,
  insertOutboundMessage,
  schema,
  sql,
  sqlExecutor,
} from "@relay/db";
import {
  createKairos,
  isKairosControl,
  type Kairos,
  NonRetryableError,
  type RunRow,
  type WorkflowContext,
} from "@relay/kairos";
import type { Queue } from "bullmq";
import type { InboundHook } from "../channels/ingest";
import { channels } from "../channels/registry";
import { nextTimeOfDay, readAnswer, withinBusinessHours } from "./helpers";

/*
 * Automations on Kairos.
 *
 *   inbound message ──(same transaction)──► publish "message.received" (wakes a run waiting for it)
 *                                       └─► start relay.route (one per message, serial per chat)
 *   relay.route: stops the chat's run on STOP, leaves replies to the run in charge, or picks the
 *                automation the message starts (one per message) and starts relay.automation
 *   relay.automation: walks the pinned version's steps; each step is a Kairos step, so a crash
 *                resumes after the last finished one and nothing is sent twice
 *
 * The chat's controller (conversation.automation_run_id) is set when a run starts and cleared when it
 * ends; a stale one (run already finished) is ignored and cleared by the next message.
 */

type Db = ReturnType<typeof createDb>["db"];
const finished = new Set(["completed", "failed", "cancelled"]);
const isLive = (r: RunRow | null | undefined) => !!r && !finished.has(r.status);

export type RouterInput =
  | { kind: "message"; event: InboundEventPayload; matched: string[] }
  | {
      kind: "tag";
      organizationId: string;
      branchId: string;
      contactId: string;
      tagId: string;
      eventId: string;
    };

export function createAutomations({
  db,
  redis,
  outbox,
  outboxJobOptions,
  databaseUrl,
  listenUrl,
  signals,
  canType = (type) => {
    const adapter = channels().get(type as ChannelType);
    return !!adapter?.markRead && !!adapter.capabilities.readReceipts;
  },
}: {
  db: Db;
  redis: Publisher;
  outbox: Queue;
  outboxJobOptions: Record<string, unknown>;
  databaseUrl: string;
  listenUrl?: string;
  /** Read receipts and "typing…" (queue "signals"); without it automations never show typing. */
  signals?: Pick<Queue, "add">;
  /** Whether a channel type can show "typing…" (WhatsApp can). */
  canType?: (channelType: string) => boolean;
}) {
  const kairos: Kairos = createKairos({ databaseUrl, listenUrl, maxConnections: 8 });

  const announce = (c: { organizationId: string; id: string; branchId: string | null }) =>
    publishInboxEvent(redis, c.organizationId, {
      type: "conversation.updated",
      conversationId: c.id,
      branchId: c.branchId,
    });

  async function conversationOf(id: string) {
    const [c] = await db.select().from(schema.conversation).where(eq(schema.conversation.id, id)).limit(1);
    return c ?? null;
  }

  /** Clears the chat's controller if it is still this run. */
  async function release(conversationId: string, runId: string) {
    const rows = await db
      .update(schema.conversation)
      .set({ automationRunId: null, updatedAt: new Date() })
      .where(and(eq(schema.conversation.id, conversationId), eq(schema.conversation.automationRunId, runId)))
      .returning();
    if (rows[0]) await announce(rows[0]);
  }

  // ---------------------------------------------------------------- router

  const router = kairos.workflow<RouterInput, unknown>(
    { ...automationWorkflows.router, retries: 5 },
    async (ctx, input) =>
      ctx.step<Record<string, unknown>>("route", () =>
        input.kind === "tag" ? routeTag(input) : route(input),
      ),
  );

  /** A team member tagged a contact: start each live automation on that tag, in the contact's chat on its number. */
  async function routeTag(t: Extract<RouterInput, { kind: "tag" }>) {
    const rows = await db
      .select({ a: schema.automation, v: schema.automationVersion })
      .from(schema.automation)
      .innerJoin(schema.automationVersion, eq(schema.automationVersion.id, schema.automation.liveVersionId))
      .where(
        and(
          eq(schema.automation.organizationId, t.organizationId),
          eq(schema.automation.branchId, t.branchId),
          eq(schema.automation.status, "live"),
          eq(schema.automation.triggerType, "tag_added"),
        ),
      );
    const results: Record<string, string> = {};
    for (const r of rows) {
      const def = migrateDefinition(r.v.definition);
      if (def.trigger.type !== "tag_added" || def.trigger.tagId !== t.tagId || !r.a.channelAccountId)
        continue;
      const [conv] = await db
        .select()
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.contactId, t.contactId),
            eq(schema.conversation.channelAccountId, r.a.channelAccountId),
            eq(schema.conversation.kind, "direct"),
          ),
        )
        .orderBy(sql`${schema.conversation.lastMessageAt} desc nulls last`)
        .limit(1);
      if (!conv) {
        results[r.a.id] = "no_chat_on_this_number";
        continue;
      }
      const controller = conv.automationRunId ? await kairos.getRun(conv.automationRunId) : null;
      if (isLive(controller?.run)) {
        results[r.a.id] = "chat_in_automation";
        continue;
      }
      const skip = await ruleBlocks(def, r.a.id, t.contactId, conv.assignedUserId);
      if (skip) {
        results[r.a.id] = skip;
        continue;
      }
      results[r.a.id] =
        (await startRun({
          def,
          versionId: r.v.id,
          automationId: r.a.id,
          conversation: conv,
          contactId: t.contactId,
          idempotencyKey: `tag:${t.contactId}:${t.tagId}:${t.eventId}:${r.a.id}`,
          trigger: { kind: "tag", tagId: t.tagId },
        })) ?? "chat_in_automation";
    }
    return { action: "tag", results };
  }

  async function route({ event: ev, matched }: Extract<RouterInput, { kind: "message" }>) {
    const conv = await conversationOf(ev.conversationId);
    if (!conv) return { action: "no_chat" };

    // The run in charge of this chat, if it is still going.
    const controller = conv.automationRunId ? await kairos.getRun(conv.automationRunId) : null;
    if (conv.automationRunId && !isLive(controller?.run)) await release(conv.id, conv.automationRunId);
    const live = isLive(controller?.run) ? controller : null;
    const labels = (live?.run.labels ?? {}) as Partial<AutomationRunLabels>;

    if (ev.optOut === "stop") {
      if (live && labels.stopOnOptOut !== false) {
        await kairos.cancel(live.run.id);
        await release(conv.id, live.run.id);
        return { action: "stopped", reason: "opt_out", runId: live.run.id };
      }
      return { action: "ignored", reason: "opt_out" };
    }
    // A reply that a waiting run took is that run's answer, even if the run has finished by now (the
    // router runs after it): it must never also start an automation, e.g. "menu" typed as an answer.
    if (matched.length) return { action: "answered", runIds: matched };
    if (live) return { action: "ignored", reason: "chat_in_automation" };

    // A tap on a button from an automation's earlier (finished) run: carry on from that choice.
    const resumed = await resumeFromTap(ev, conv);
    if (resumed) return resumed;

    // Which live automation this message starts: candidates on this number, most specific wins.
    const rows = await db
      .select({ a: schema.automation, v: schema.automationVersion })
      .from(schema.automation)
      .innerJoin(schema.automationVersion, eq(schema.automationVersion.id, schema.automation.liveVersionId))
      .where(
        and(
          eq(schema.automation.organizationId, ev.organizationId),
          eq(schema.automation.channelAccountId, ev.channelAccountId),
          eq(schema.automation.status, "live"),
          inArray(schema.automation.triggerType, ["message_received", "ad_click"]),
        ),
      );
    if (!rows.length) return { action: "none", reason: "no_live_automation" };
    const inbound = await db.execute(sql`
      select count(*)::int as n from (select 1 from message
        where conversation_id = ${conv.id} and direction = 'inbound' limit 2) x`);
    const isFirstMessage = Number((inbound as unknown as { n: number }[])[0]?.n ?? 0) <= 1;
    const candidates = rows.map((r) => ({
      id: r.a.id,
      trigger: (r.v.definition as AutomationDefinition).trigger,
      updatedAt: r.a.updatedAt,
      row: r,
    }));
    const pick = pickAutomation(candidates, { text: ev.text, isFirstMessage, adId: ev.adId });
    if (!pick) return { action: "none", reason: "no_trigger_matched" };
    const def = migrateDefinition(pick.row.v.definition);

    const skip = await ruleBlocks(def, pick.id, ev.contactId, conv.assignedUserId);
    if (skip) return { action: "skipped", reason: skip, automationId: pick.id };

    const runId = await startRun({
      def,
      versionId: pick.row.v.id,
      automationId: pick.id,
      conversation: conv,
      contactId: ev.contactId,
      idempotencyKey: `msg:${ev.messageId}`,
      trigger: { kind: "message", messageId: ev.messageId, text: ev.text, adId: ev.adId },
    });
    if (!runId) return { action: "ignored", reason: "chat_in_automation" };
    return { action: "started", automationId: pick.id, runId };
  }

  /**
   * The customer tapped a button that a finished run of a live automation sent (on this number): start
   * that automation again at the choice they tapped, or from the top when that step or option is no
   * longer in the live version (they get the current menu). Null when the message isn't such a tap.
   * The re-entry rule doesn't apply (they're answering the automation, not starting it); the others do.
   */
  async function resumeFromTap(
    ev: InboundEventPayload,
    conv: typeof schema.conversation.$inferSelect,
  ): Promise<Record<string, unknown> | null> {
    if (!ev.reply) return null;
    const src = await tapSource(ev.messageId);
    const key = src ? parseStepKey(src.stepKey) : null;
    const option = optionOfReply(ev.reply.id);
    if (!src || !key || !option) return null;
    const [row] = await db
      .select({ a: schema.automation, v: schema.automationVersion })
      .from(schema.automation)
      .innerJoin(schema.automationVersion, eq(schema.automationVersion.id, schema.automation.liveVersionId))
      .where(
        and(
          eq(schema.automation.id, src.automationId),
          eq(schema.automation.organizationId, ev.organizationId),
          eq(schema.automation.channelAccountId, ev.channelAccountId),
          eq(schema.automation.status, "live"),
        ),
      )
      .limit(1);
    if (!row) return null;
    const def = migrateDefinition(row.v.definition);
    const skip = await ruleBlocks(def, row.a.id, ev.contactId, conv.assignedUserId, { reentry: false });
    if (skip) return { action: "skipped", reason: skip, automationId: row.a.id };
    const target = tapTarget(def, key.nodeId, option);
    const runId = await startRun({
      def,
      versionId: row.v.id,
      automationId: row.a.id,
      conversation: conv,
      contactId: ev.contactId,
      idempotencyKey: `msg:${ev.messageId}`,
      trigger: { kind: "button", messageId: ev.messageId, text: ev.text },
      startAt: target ?? undefined,
    });
    if (!runId) return { action: "ignored", reason: "chat_in_automation" };
    return { action: target ? "resumed_at_choice" : "restarted", automationId: row.a.id, runId };
  }

  /** Why the run rules keep this contact out right now, or null. */
  async function ruleBlocks(
    def: AutomationDefinition,
    automationId: string,
    contactId: string,
    assignedUserId: string | null,
    o: { reentry?: boolean } = {},
  ): Promise<string | null> {
    const rules = def.rules;
    if (rules.skipIfAssigned && assignedUserId) return "chat_assigned";
    if (rules.skipIfInAnotherRun) {
      const theirs = await kairos.listRuns({
        workflow: automationWorkflows.run.name,
        labels: { contactId },
        status: ["queued", "running", "sleeping", "waiting"],
        limit: 1,
      });
      if (theirs.length) return "in_another_run";
    }
    if (rules.reentry !== "every_time" && o.reentry !== false) {
      // Test runs from the editor don't count: testing on yourself must not use up "Only once".
      const [last] = await kairos.listRuns({
        workflow: automationWorkflows.run.name,
        labels: { automationId, contactId },
        withoutLabels: ["test"],
        limit: 1,
      });
      if (last && rules.reentry === "once") return "already_entered";
      if (
        last &&
        rules.reentry === "cooldown" &&
        Date.now() - new Date(last.created_at).getTime() < (rules.cooldownHours ?? 24) * 3_600_000
      )
        return "cooldown";
    }
    return null;
  }

  /** Starts a run and puts it in charge of the chat, together (one transaction). */
  async function startRun(o: {
    def: AutomationDefinition;
    versionId: string;
    automationId: string;
    conversation: typeof schema.conversation.$inferSelect;
    contactId: string;
    idempotencyKey: string;
    trigger: AutomationRunInput["trigger"];
    startAt?: AutomationRunInput["startAt"];
    test?: boolean;
  }): Promise<string | null> {
    const c = o.conversation;
    const input: AutomationRunInput = {
      automationId: o.automationId,
      versionId: o.versionId,
      organizationId: c.organizationId,
      branchId: c.branchId ?? "",
      channelAccountId: c.channelAccountId,
      conversationId: c.id,
      contactId: o.contactId,
      trigger: o.trigger,
      typing: o.def.rules.typing !== false,
      followTaps: true,
      ...(o.startAt ? { startAt: o.startAt } : {}),
    };
    const labels: AutomationRunLabels = {
      automationId: o.automationId,
      versionId: o.versionId,
      contactId: o.contactId,
      conversationId: c.id,
      stopOnAgentReply: o.def.rules.stopOnAgentReply,
      stopOnOptOut: o.def.rules.stopOnOptOut,
      ...(o.test ? { test: true } : {}),
    };
    const runId = await db.transaction(async (tx) => {
      // Lock the chat: a run started from the inbox at the same moment can't also take charge.
      const [locked] = await tx
        .select({ automationRunId: schema.conversation.automationRunId })
        .from(schema.conversation)
        .where(eq(schema.conversation.id, c.id))
        .for("update");
      if (locked?.automationRunId && isLive((await kairos.getRun(locked.automationRunId))?.run)) return null;
      const { runId } = await kairos.start(run, input, {
        tenantId: c.organizationId,
        serialKey: c.id,
        idempotencyKey: o.idempotencyKey,
        labels,
        executor: sqlExecutor(tx),
      });
      await tx
        .update(schema.conversation)
        .set({ automationRunId: runId, updatedAt: new Date() })
        .where(eq(schema.conversation.id, c.id));
      return runId;
    });
    if (!runId) return null; // another run took the chat first
    kairos.nudge();
    await announce(c);
    return runId;
  }

  // ---------------------------------------------------------------- run

  const run = kairos.workflow<AutomationRunInput, unknown>(
    { ...automationWorkflows.run, retries: 3, backoff: { baseMs: 2_000 } },
    async (ctx, input) => {
      const [version] = await db
        .select({ definition: schema.automationVersion.definition })
        .from(schema.automationVersion)
        .where(eq(schema.automationVersion.id, input.versionId))
        .limit(1);
      // Published versions never change, so reading one here is the same on every replay.
      if (!version) throw new NonRetryableError("The automation version this run started on was deleted.");
      const def = migrateDefinition(version.definition);
      const nodes = new Map(def.nodes.map((n) => [n.id, n]));
      const next = new Map(def.edges.map((e) => [`${e.source}:${e.sourceHandle}`, e.target]));
      const memory: RunMemory = { answers: {}, path: [] };
      const visits = new Map<string, number>();
      let executed = 0;
      let current = next.get("trigger:next");
      if (input.startAt) {
        // Started by a tap on a button from an earlier run: carry on from that choice.
        const t = input.startAt;
        if (t.saveAs) memory.answers[t.saveAs] = t.value;
        memory.path.push(`trigger:older_button`, `${t.node}:${t.handle}`);
        current = next.get(`${t.node}:${t.handle}`);
      }
      try {
        while (current) {
          const node = nodes.get(current);
          if (!node) break;
          const visit = (visits.get(node.id) ?? 0) + 1;
          visits.set(node.id, visit);
          if (visit > LIMITS.maxVisitsPerStep || ++executed > LIMITS.maxExecutions)
            throw new NonRetryableError(
              `Stopped: the automation went round a loop too many times (step ${node.id}, visit ${visit}).`,
            );
          const handle = await runStep(ctx, input, def, node, visit, memory);
          if (handle !== null && typeof handle === "object") {
            // They tapped a button from an earlier message instead: go where that choice leads.
            const t = handle.jump;
            if (t.saveAs) memory.answers[t.saveAs] = t.value;
            memory.path.push(`${node.id}:older_button`, `${t.node}:${t.handle}`);
            current = next.get(`${t.node}:${t.handle}`);
            continue;
          }
          memory.path.push(`${node.id}:${handle ?? "end"}`);
          if (handle === null) break;
          current = next.get(`${node.id}:${handle}`);
        }
      } catch (err) {
        if (isKairosControl(err)) throw err;
        await ctx.step("release chat", () => release(input.conversationId, ctx.runId));
        throw err;
      }
      await ctx.step("release chat", () => release(input.conversationId, ctx.runId));
      return { answers: memory.answers, path: memory.path };
    },
  );

  type RunMemory = { answers: Record<string, string>; path: string[] };
  /** An exit, the end (null), or a jump to where an older button of this automation leads. */
  type Exit = string | null | { jump: TapTarget };

  /** Runs one step and returns the exit it takes (null: the run ends here). */
  async function runStep(
    ctx: WorkflowContext,
    input: AutomationRunInput,
    def: AutomationDefinition,
    node: AutomationNode,
    visit: number,
    memory: RunMemory,
  ): Promise<Exit> {
    const spec = nodeSpec(node.type);
    if (!spec) throw new NonRetryableError(`Unknown step type ${node.type}`);
    const config = spec.config.parse(node.config);
    const name = `${node.type}:${node.id}#${visit}`;
    const stepKey = `${ctx.runId}:${node.id}#${visit}`;

    switch (node.type) {
      case "send_message": {
        const m = config as SendMessageConfig;
        await typeFirst(ctx, input, name, m.text);
        const r = await ctx.step(name, () => sendMessage(input, memory, stepKey, m));
        if (!r.ok) return "failed";
        return m.waitForReply ? waitForReply(ctx, input, def, memory, name, stepKey, m, []) : "next";
      }
      case "send_template": {
        const t = config as SendTemplateConfig;
        await typeFirst(ctx, input, name, "");
        const r = await ctx.step(name, () => sendTemplate(input, memory, stepKey, t));
        if (!r.ok) return "failed";
        return t.waitForReply
          ? waitForReply(ctx, input, def, memory, name, stepKey, t, t.replyButtons)
          : "next";
      }
      case "ask_question":
        return ask(ctx, input, def, memory, name, stepKey, config as AskQuestionConfig);
      case "condition": {
        const yes = await ctx.step(name, () => evaluate(input, memory, config as ConditionConfig));
        return yes ? "yes" : "no";
      }
      case "wait": {
        const w = config as WaitConfig;
        if (w.mode === "delay") {
          const unit = w.unit === "minutes" ? 60_000 : w.unit === "hours" ? 3_600_000 : 86_400_000;
          await ctx.sleep(name, w.amount * unit);
        } else {
          const at = await ctx.step(`${name}:when`, () => nextTimeOfDay(w.time, w.timezone).getTime());
          await ctx.sleepUntil(name, new Date(at));
        }
        return "next";
      }
      case "add_tag":
      case "remove_tag": {
        const tagId = (config as { tagId: string }).tagId;
        await ctx.step(name, async () => {
          const c = schema.contact;
          await db
            .update(c)
            .set({
              tagIds:
                node.type === "add_tag"
                  ? sql`(select array(select distinct unnest(${c.tagIds} || array[${tagId}]::text[])))`
                  : sql`array_remove(${c.tagIds}, ${tagId})`,
              updatedAt: new Date(),
            })
            .where(eq(c.id, input.contactId));
        });
        return "next";
      }
      case "set_field": {
        const f = config as { fieldKey: string; value: string };
        await ctx.step(name, async () => {
          const value = resolveText(f.value, await scopeOf(input, memory));
          const c = schema.contact;
          await db
            .update(c)
            .set({
              attributes: sql`coalesce(${c.attributes}, '{}'::jsonb) || jsonb_build_object(${f.fieldKey}::text, ${value}::text)`,
              updatedAt: new Date(),
            })
            .where(eq(c.id, input.contactId));
        });
        return "next";
      }
      case "assign": {
        const userId = (config as { userId: string | null }).userId;
        await ctx.step(name, () => updateChat(input.conversationId, { assignedUserId: userId }));
        return "next";
      }
      case "add_note": {
        const text = (config as { text: string }).text;
        await ctx.step(name, () => addNote(input, memory, stepKey, text));
        return "next";
      }
      case "close_chat":
        await ctx.step(name, () => updateChat(input.conversationId, { status: "closed" }));
        return "next";
      case "handoff": {
        const h = config as { userId: string | null; note: string };
        await ctx.step(name, async () => {
          if (h.note.trim()) await addNote(input, memory, stepKey, h.note);
          await updateChat(input.conversationId, {
            status: "open",
            ...(h.userId ? { assignedUserId: h.userId } : {}),
          });
        });
        return null;
      }
      case "end":
        return null;
      default:
        throw new NonRetryableError(`No runtime for step type ${node.type}`);
    }
  }

  /**
   * After a send with "Wait for a reply": their next message takes "Replied" (a tap on one of this
   * template's quick-reply buttons, or typing its title, takes that button's exit); nothing before the
   * timeout takes "No reply". The reply is saved under saveAs when given.
   */
  async function waitForReply(
    ctx: WorkflowContext,
    input: AutomationRunInput,
    def: AutomationDefinition,
    memory: RunMemory,
    name: string,
    stepKey: string,
    cfg: { saveAs: string; timeoutMinutes: number },
    buttons: { index: number; title: string }[],
  ): Promise<Exit> {
    const reply = await ctx.waitForEvent<InboundEventPayload>(`${name}:reply`, {
      key: automationEvents.messageReceived,
      scope: input.conversationId,
      timeoutMs: cfg.timeoutMinutes * 60_000,
      // A reply typed while the bot was "typing" this message counts too.
      lookbackFrom: input.typing ? `${name}:typing` : undefined,
    });
    if (reply.timedOut) return "no_reply";
    const p = reply.event.payload;
    let handle = "replied";
    let value = p.text;
    const tapped = p.reply ? optionFromReply(stepKey, p.reply.id) : null;
    const typed = p.text.trim().toLowerCase();
    const button =
      buttons.find((b) => tapped !== null && String(b.index) === tapped) ??
      (typed ? buttons.find((b) => b.title.trim().toLowerCase() === typed) : undefined);
    if (button) {
      handle = `btn:${button.index}`;
      value = button.title;
    } else if (p.reply && tapped === null && input.followTaps) {
      const jump = await ctx.step(`${name}:older_button`, () => olderTap(input, def, p));
      if (jump) return { jump };
    }
    if (cfg.saveAs) memory.answers[cfg.saveAs] = value;
    return handle;
  }

  /** Ask, then wait for an answer that fits; re-ask up to `retries` times, all within one deadline. */
  async function ask(
    ctx: WorkflowContext,
    input: AutomationRunInput,
    def: AutomationDefinition,
    memory: RunMemory,
    name: string,
    stepKey: string,
    q: AskQuestionConfig,
  ): Promise<Exit> {
    await typeFirst(ctx, input, name, q.text);
    const sent = await ctx.step(`${name}:ask`, () => sendQuestion(input, memory, stepKey, q, q.text));
    if (!sent.ok) return "failed";
    const deadline = await ctx.step(`${name}:deadline`, () => Date.now() + q.timeoutMinutes * 60_000);
    for (let attempt = 0; ; attempt++) {
      const reply = await ctx.waitForEvent<InboundEventPayload>(`${name}:answer${attempt}`, {
        key: automationEvents.messageReceived,
        scope: input.conversationId,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
        // An answer typed while the bot was "typing" the question (or the re-ask) counts too.
        lookbackFrom: input.typing ? (attempt ? `${name}:re${attempt}:typing` : `${name}:typing`) : undefined,
      });
      if (reply.timedOut) return "no_reply";
      const answer = readAnswer(q, reply.event.payload, (id) => optionFromReply(stepKey, id));
      if (answer) {
        memory.answers[q.saveAs] = answer.value;
        return answer.handle;
      }
      const p = reply.event.payload;
      if (p.reply && input.followTaps) {
        // A button from an earlier question of this automation: go where that choice leads.
        const jump = await ctx.step(`${name}:older_button${attempt}`, () => olderTap(input, def, p));
        if (jump) return { jump };
      }
      if (attempt >= q.retries) return "invalid";
      await typeFirst(ctx, input, `${name}:re${attempt + 1}`, q.retryText);
      const again = await ctx.step(`${name}:reask${attempt + 1}`, () =>
        sendQuestion(input, memory, `${stepKey}:re${attempt + 1}`, q, q.retryText, stepKey),
      );
      if (!again.ok) return "failed";
    }
  }

  /**
   * The bot message a tapped button belongs to (WhatsApp says which message it answers), with the
   * automation and step that sent it.
   */
  async function tapSource(messageId: string) {
    const rows = (await db.execute(sql`
      select b.automation_id as "automationId", b.automation_step_key as "stepKey"
      from message m join message b on b.id = m.reply_to_message_id
      where m.id = ${messageId} and b.automation_id is not null and b.automation_step_key is not null
      limit 1`)) as unknown as { automationId: string; stepKey: string }[];
    return rows[0] ?? null;
  }

  /** Where a tap on one of this automation's earlier buttons leads in this run's version, or null. */
  async function olderTap(
    input: AutomationRunInput,
    def: AutomationDefinition,
    p: InboundEventPayload,
  ): Promise<TapTarget | null> {
    if (!p.reply) return null;
    const src = await tapSource(p.messageId);
    if (src?.automationId !== input.automationId) return null;
    const key = parseStepKey(src.stepKey);
    const option = optionOfReply(p.reply.id);
    return key && option ? tapTarget(def, key.nodeId, option) : null;
  }

  /**
   * Before a message: "typing…" in the customer's WhatsApp, then a pause about as long as typing it
   * would take, so the bot reads like a person. Only for runs that started with typing on; skipped
   * (no pause) when typing can't be shown: the chat's window is closed, read receipts are off for
   * the number, or the customer hasn't written yet.
   */
  async function typeFirst(ctx: WorkflowContext, input: AutomationRunInput, name: string, text: string) {
    if (!input.typing) return;
    const shown = await ctx.step(`${name}:typing`, () => showTyping(input, `${ctx.runId}_${name}`));
    if (shown) await ctx.sleep(`${name}:pause`, typingPauseMs(text));
  }

  /** Queues WhatsApp's typing indicator on the customer's latest message (it also marks it read). */
  async function showTyping(input: AutomationRunInput, key: string): Promise<boolean> {
    if (!signals) return false;
    const conv = await conversationOf(input.conversationId);
    if (conv?.kind !== "direct" || !conv.windowExpiresAt || conv.windowExpiresAt <= new Date()) return false;
    const [account] = await db
      .select({
        type: schema.channelAccount.type,
        status: schema.channelAccount.status,
        settings: schema.channelAccount.settings,
      })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, conv.channelAccountId))
      .limit(1);
    if (account?.status !== "active" || account.settings.readReceipts === false || !canType(account.type))
      return false;
    const m = schema.message;
    const [newest] = await db
      .select({ id: m.id })
      .from(m)
      .where(and(eq(m.conversationId, conv.id), eq(m.direction, "inbound"), sql`${m.externalId} is not null`))
      .orderBy(sql`${m.sentAt} desc`)
      .limit(1);
    if (!newest) return false;
    // Typing marks their message read on WhatsApp; the inbox keeps track of that.
    await db
      .update(schema.conversation)
      .set({ providerReadMessageId: newest.id })
      .where(eq(schema.conversation.id, conv.id));
    // Best effort: a missed "typing…" isn't worth holding the message for, so give up after 1 s.
    await Promise.race([
      signals.add(
        "typing",
        { kind: "typing", conversationId: conv.id, messageId: newest.id } satisfies SignalJob,
        {
          jobId: `typing_${key.replace(/[^A-Za-z0-9_-]/g, "_")}`,
          attempts: 1,
          removeOnComplete: { age: 60 },
          removeOnFail: { age: 3600 },
        },
      ),
      new Promise((r) => setTimeout(r, 1_000)),
    ]).catch(() => {});
    return true;
  }

  // ---------------------------------------------------------------- side effects (inside steps)

  type Sent = { ok: true; messageId: string } | { ok: false; reason: string };

  async function scopeOf(input: AutomationRunInput, memory: RunMemory): Promise<VariableScope> {
    const [contact] = await db
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, input.contactId))
      .limit(1);
    const conv = await conversationOf(input.conversationId);
    const [org] = await db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, input.organizationId))
      .limit(1);
    const [assignee] = conv?.assignedUserId
      ? await db
          .select({ name: schema.user.name })
          .from(schema.user)
          .where(eq(schema.user.id, conv.assignedUserId))
          .limit(1)
      : [];
    return {
      contact: {
        ...((contact?.attributes as Record<string, unknown>) ?? {}),
        name: contact?.name ?? "",
        phone: contact?.phone ?? "",
        email: contact?.email ?? "",
      },
      trigger: { text: input.trigger.text ?? "" },
      answers: memory.answers,
      chat: { assignee: assignee?.name ?? "" },
      business: { name: org?.name ?? "" },
    };
  }

  /** Saves the message (once per step key), queues it and refreshes the inbox. */
  async function queueSend(
    input: AutomationRunInput,
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
    if (type !== "template" && (!conv.windowExpiresAt || conv.windowExpiresAt <= new Date()))
      return { ok: false, reason: "window_closed" };
    const { message } = await insertOutboundMessage(db, {
      id: newId("message"),
      conversation: conv,
      type,
      content: { ...content, automationId: input.automationId },
      senderType: "bot",
      senderName: "Automation",
      attachmentId,
      automationId: input.automationId,
      automationStepKey: stepKey,
    });
    if (message.status === "queued") {
      // If Redis is away this gives up after 5 s; the worker's minute sweep queues it later.
      await Promise.race([
        outbox.add("send", { messageId: message.id }, { jobId: message.id, ...outboxJobOptions }),
        new Promise((r) => setTimeout(r, 5_000)),
      ]).catch(() => {});
    }
    await announce(conv);
    return { ok: true, messageId: message.id };
  }

  async function sendMessage(
    input: AutomationRunInput,
    memory: RunMemory,
    stepKey: string,
    m: SendMessageConfig,
  ): Promise<Sent> {
    const text = resolveText(m.text, await scopeOf(input, memory));
    if (!m.media) return queueSend(input, stepKey, "text", { type: "text", text });
    const [file] = await db
      .select()
      .from(schema.storedFile)
      .where(
        and(
          eq(schema.storedFile.id, m.media.fileId),
          eq(schema.storedFile.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!file) return { ok: false, reason: "file_missing" };
    // Each send gets its own attachment row pointing at the stored file; the outbox uploads it.
    const attachmentId = newId("attachment");
    await db.insert(schema.attachment).values({
      id: attachmentId,
      organizationId: input.organizationId,
      kind: m.media.kind,
      mimeType: file.mimeType,
      fileName: m.media.name ?? null,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      fileId: file.id,
      storageKey: file.storageKey,
      // Already in our storage: the chat shows it straight away (nothing to download from Meta).
      status: "stored",
    });
    return queueSend(
      input,
      stepKey,
      m.media.kind,
      {
        type: m.media.kind,
        caption: text || null,
        media: {
          providerMediaId: null,
          mimeType: file.mimeType,
          fileName: m.media.name ?? null,
          sha256: file.sha256,
          caption: text || null,
        },
      },
      attachmentId,
    );
  }

  async function sendTemplate(
    input: AutomationRunInput,
    memory: RunMemory,
    stepKey: string,
    t: SendTemplateConfig,
  ): Promise<Sent> {
    const conv = await conversationOf(input.conversationId);
    if (!conv) return { ok: false, reason: "chat_gone" };
    const [row] = await db
      .select({ template: schema.messageTemplate, copy: schema.templateChannel })
      .from(schema.messageTemplate)
      .innerJoin(
        schema.templateChannel,
        and(
          eq(schema.templateChannel.templateId, schema.messageTemplate.id),
          eq(schema.templateChannel.channelAccountId, conv.channelAccountId),
        ),
      )
      .where(
        and(
          eq(schema.messageTemplate.id, t.templateId),
          eq(schema.messageTemplate.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (row?.copy.status !== "ready") return { ok: false, reason: "template_not_ready" };
    const scope = await scopeOf(input, memory);
    const values: Record<string, string> = {};
    for (const v of templateVariables(row.template.content as unknown as TemplateContent)) {
      const filled = resolveText(t.values[v] ?? "", scope).trim();
      if (!filled) return { ok: false, reason: `missing_value:${v}` };
      values[v] = filled;
    }
    const content = templateMessageContent(row.template, values);
    // Waiting for a tap: each quick-reply button sends back a payload marked with this step.
    if (t.waitForReply && t.replyButtons.length)
      content.quickReplyPayloads = t.replyButtons.map((b) => ({
        index: b.index,
        payload: optionReplyId(stepKey, String(b.index)),
      }));
    return queueSend(input, stepKey, "template", content);
  }

  async function sendQuestion(
    input: AutomationRunInput,
    memory: RunMemory,
    sendKey: string,
    q: AskQuestionConfig,
    text: string,
    questionKey = sendKey,
  ): Promise<Sent> {
    const body = resolveText(text, await scopeOf(input, memory));
    if (q.answer.type === "text") return queueSend(input, sendKey, "text", { type: "text", text: body });
    const options = q.answer.options;
    return queueSend(input, sendKey, "interactive", {
      type: "interactive",
      kind: askLayout(options.length) === "buttons" ? "buttons" : "list",
      body,
      buttonText: "Choose",
      // Ids carry the question's mark, so a tap on an older question's button isn't taken as this answer.
      options: options.map((o) => ({ id: optionReplyId(questionKey, o.id), title: o.title })),
    });
  }

  async function addNote(input: AutomationRunInput, memory: RunMemory, stepKey: string, raw: string) {
    const text = resolveText(raw, await scopeOf(input, memory));
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
        senderType: "bot",
        type: "note",
        content: { type: "note", text, mentions: [], automationId: input.automationId },
        status: "sent",
        automationId: input.automationId,
        automationStepKey: `${stepKey}:note`,
        sentAt: new Date(),
      })
      .onConflictDoNothing();
    await announce(conv);
  }

  async function updateChat(
    conversationId: string,
    set: Partial<{ assignedUserId: string | null; status: "open" | "closed" }>,
  ) {
    const [c] = await db
      .update(schema.conversation)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(schema.conversation.id, conversationId))
      .returning();
    if (c) await announce(c);
  }

  async function evaluate(input: AutomationRunInput, memory: RunMemory, cond: ConditionConfig) {
    const results: boolean[] = [];
    let fields: Awaited<ReturnType<typeof activeFields>> | null = null;
    for (const rule of cond.rules) {
      if (rule.kind === "window_open") {
        const conv = await conversationOf(input.conversationId);
        results.push(!!conv?.windowExpiresAt && conv.windowExpiresAt > new Date());
      } else if (rule.kind === "business_hours") {
        results.push(withinBusinessHours(rule, new Date()));
      } else if (rule.kind === "contact") {
        fields ??= await activeFields(db, input.organizationId);
        const where = compileFilter(
          { match: "all", rules: [rule.rule as never] },
          new Map(fields.map((f) => [f.key, f as never])),
        );
        const rows = await db
          .select({ id: schema.contact.id })
          .from(schema.contact)
          .where(
            where
              ? and(eq(schema.contact.id, input.contactId), where)
              : eq(schema.contact.id, input.contactId),
          )
          .limit(1);
        results.push(rows.length > 0);
      } else {
        const value =
          rule.kind === "answer"
            ? (memory.answers[rule.name] ?? "")
            : resolveText(`{{${rule.name}}}`, await scopeOf(input, memory));
        results.push(compare(value, rule.op, rule.value ?? ""));
      }
    }
    return cond.match === "all" ? results.every(Boolean) : results.some(Boolean);
  }

  // ---------------------------------------------------------------- entry points

  /** Set once the kairos schema is migrated; until then messages are stored without automations. */
  let ready = false;
  async function startWorker(w: ReturnType<typeof kairos.worker>) {
    await kairos.migrate();
    ready = true;
    await w.start();
  }

  /**
   * From ingest, inside the transaction that stored a customer's message. Runs in a savepoint: if it
   * fails, the message is still stored (automations miss it, which is logged) rather than the whole
   * webhook failing and retrying.
   */
  const onInbound: InboundHook = async (tx, ev) => {
    if (!ready) return;
    try {
      await tx.transaction(async (sp) => {
        const ex = sqlExecutor(sp);
        const pub = await kairos.publish(
          {
            tenantId: ev.organizationId,
            key: automationEvents.messageReceived,
            scope: ev.conversationId,
            payload: ev as never,
            dedupeKey: ev.messageId,
          },
          { executor: ex },
        );
        await kairos.start(
          router,
          { kind: "message", event: ev, matched: pub.matchedRuns },
          {
            tenantId: ev.organizationId,
            serialKey: ev.conversationId,
            idempotencyKey: `in:${ev.messageId}`,
            labels: { conversationId: ev.conversationId },
            executor: ex,
          },
        );
      });
    } catch (err) {
      console.error(`automations missed message ${ev.messageId}: ${(err as Error).message}`);
    }
  };

  return {
    kairos,
    router,
    run,
    onInbound,
    startRun,
    worker: () => kairos.worker({ workflows: [router, run], concurrency: 20, tenantCap: 10 }),
    startWorker,
  };
}

function compare(value: string, op: string, expected: string): boolean {
  const v = value.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  switch (op) {
    case "is":
      return v === e;
    case "is_not":
      return v !== e;
    case "contains":
      return !!e && v.includes(e);
    case "is_empty":
      return !v;
    case "is_not_empty":
      return !!v;
    case "gt":
      return Number(v) > Number(e);
    case "lt":
      return Number(v) < Number(e);
    default:
      return false;
  }
}
