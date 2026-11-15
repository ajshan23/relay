import { publishInboxEvent } from "@relay/core";
import {
  type AutomationDefinition,
  type AutomationRunInput,
  type AutomationRunLabels,
  automationWorkflows,
  migrateDefinition,
} from "@relay/core/automations";
import { and, eq, schema, sqlExecutor } from "@relay/db";
import type { RunRow } from "@relay/kairos";
import type { AppContext } from "../../context";

/*
 * Starting and stopping automation runs from the API (run from chat, test runs, a team member's reply
 * stopping the bot). Runs execute in the worker; here a run is only created (in Kairos) and put in
 * charge of the chat, in one transaction.
 */

const finished = new Set(["completed", "failed", "cancelled"]);
export const isLiveRun = (r: Pick<RunRow, "status"> | null | undefined) => !!r && !finished.has(r.status);

/** Workflow references for starting runs; the handlers live in the worker. */
export function runWorkflow(ctx: AppContext) {
  return ctx.kairos.workflow(automationWorkflows.run, async () => {
    throw new Error("Automation runs execute in the worker");
  });
}

export type StartResult =
  | { ok: true; runId: string }
  | { ok: false; status: 404 | 409 | 422; code: string; message: string };

export async function startRunInChat(
  ctx: AppContext,
  o: {
    automationId: string;
    versionId: string;
    definition: AutomationDefinition;
    conversationId: string;
    organizationId: string;
    userId: string;
    test?: boolean;
  },
): Promise<StartResult> {
  const [conv] = await ctx.db
    .select()
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.id, o.conversationId),
        eq(schema.conversation.organizationId, o.organizationId),
      ),
    )
    .limit(1);
  if (conv?.kind !== "direct" || !conv.contactId)
    return { ok: false, status: 404, code: "chat_not_found", message: "That chat wasn't found." };
  if (conv.automationRunId) {
    const current = await ctx.kairos.getRun(conv.automationRunId);
    if (isLiveRun(current?.run))
      return {
        ok: false,
        status: 409,
        code: "chat_in_automation",
        message: "Another automation is running in this chat. Stop it first.",
      };
  }
  const def = migrateDefinition(o.definition);
  const input: AutomationRunInput = {
    automationId: o.automationId,
    versionId: o.versionId,
    organizationId: conv.organizationId,
    branchId: conv.branchId ?? "",
    channelAccountId: conv.channelAccountId,
    conversationId: conv.id,
    contactId: conv.contactId,
    trigger: { kind: "manual", startedByUserId: o.userId },
    typing: def.rules.typing !== false,
    followTaps: true,
  };
  const labels: AutomationRunLabels = {
    automationId: o.automationId,
    versionId: o.versionId,
    contactId: conv.contactId,
    conversationId: conv.id,
    stopOnAgentReply: def.rules.stopOnAgentReply,
    stopOnOptOut: def.rules.stopOnOptOut,
    ...(o.test ? { test: true } : {}),
  };
  const wf = runWorkflow(ctx);
  const runId = await ctx.db.transaction(async (tx) => {
    // Two clicks (or a click and an incoming message) at once: the chat row is locked, so the second
    // sees the first run in charge and starts nothing.
    const [locked] = await tx
      .select({ automationRunId: schema.conversation.automationRunId })
      .from(schema.conversation)
      .where(eq(schema.conversation.id, conv.id))
      .for("update");
    if (locked?.automationRunId && isLiveRun((await ctx.kairos.getRun(locked.automationRunId))?.run))
      return null;
    const { runId } = await ctx.kairos.start(wf, input, {
      tenantId: conv.organizationId,
      serialKey: conv.id,
      labels,
      executor: sqlExecutor(tx),
    });
    await tx
      .update(schema.conversation)
      .set({ automationRunId: runId, updatedAt: new Date() })
      .where(eq(schema.conversation.id, conv.id));
    return runId;
  });
  if (!runId)
    return {
      ok: false,
      status: 409,
      code: "chat_in_automation",
      message: "Another automation is running in this chat. Stop it first.",
    };
  await announceChat(ctx, conv);
  return { ok: true, runId };
}

/** Tells everyone looking at this chat that it changed (the automation bar), best effort. */
async function announceChat(
  ctx: AppContext,
  conv: { id: string; organizationId: string; branchId: string | null },
) {
  try {
    await publishInboxEvent(ctx.redis, conv.organizationId, {
      type: "conversation.updated",
      conversationId: conv.id,
      branchId: conv.branchId,
    });
  } catch {
    // Redis away: their screens catch up on the next refresh.
  }
}

/** Stops a run and gives the chat back. */
export async function stopRun(ctx: AppContext, runId: string, conversationId: string | null) {
  await ctx.kairos.cancel(runId);
  if (!conversationId) return;
  const [freed] = await ctx.db
    .update(schema.conversation)
    .set({ automationRunId: null, updatedAt: new Date() })
    .where(and(eq(schema.conversation.id, conversationId), eq(schema.conversation.automationRunId, runId)))
    .returning({
      id: schema.conversation.id,
      organizationId: schema.conversation.organizationId,
      branchId: schema.conversation.branchId,
    });
  if (freed) await announceChat(ctx, freed);
}

/**
 * A team member wrote in the chat: the automation in charge stops if its rules say so (the default),
 * so the customer doesn't get the bot and a person at once. Best effort: never blocks the send.
 */
export async function stopForAgentReply(
  ctx: AppContext,
  conversation: { id: string; automationRunId: string | null },
) {
  if (!conversation.automationRunId) return;
  try {
    const current = await ctx.kairos.getRun(conversation.automationRunId);
    const labels = (current?.run.labels ?? {}) as Partial<AutomationRunLabels>;
    if (!isLiveRun(current?.run)) {
      await stopRun(ctx, conversation.automationRunId, conversation.id);
      return;
    }
    if (labels.stopOnAgentReply !== false) await stopRun(ctx, conversation.automationRunId, conversation.id);
  } catch (err) {
    console.warn("could not stop the chat's automation", err);
  }
}

/** Router workflow reference (the handler runs in the worker). */
export function routerWorkflow(ctx: AppContext) {
  return ctx.kairos.workflow(automationWorkflows.router, async () => {
    throw new Error("Routing runs in the worker");
  });
}

/**
 * Contacts just got tags: if a live automation in the branch starts on one of them, hand each new
 * (contact, tag) to the worker's router, which finds the contact's chat on the automation's number and
 * applies the run rules. Tags added by an automation itself don't come through here.
 */
export async function onTagsAdded(
  ctx: AppContext,
  orgId: string,
  branchId: string,
  added: { contactId: string; tagId: string }[],
) {
  if (!added.length) return;
  try {
    const tagIds = [...new Set(added.map((x) => x.tagId))];
    const live = await ctx.db
      .select({ definition: schema.automationVersion.definition })
      .from(schema.automation)
      .innerJoin(schema.automationVersion, eq(schema.automationVersion.id, schema.automation.liveVersionId))
      .where(
        and(
          eq(schema.automation.organizationId, orgId),
          eq(schema.automation.branchId, branchId),
          eq(schema.automation.status, "live"),
          eq(schema.automation.triggerType, "tag_added"),
        ),
      );
    const wanted = new Set(
      live
        .map((r) => (r.definition as AutomationDefinition).trigger)
        .flatMap((t) => (t.type === "tag_added" && tagIds.includes(t.tagId) ? [t.tagId] : [])),
    );
    if (!wanted.size) return;
    const router = routerWorkflow(ctx);
    const at = Date.now();
    for (const x of added.filter((p) => wanted.has(p.tagId)))
      await ctx.kairos.start(
        router,
        {
          kind: "tag",
          organizationId: orgId,
          branchId,
          contactId: x.contactId,
          tagId: x.tagId,
          eventId: `${at}`,
        },
        {
          tenantId: orgId,
          serialKey: `contact:${x.contactId}`,
          idempotencyKey: `tag:${x.contactId}:${x.tagId}:${at}`,
          labels: { contactId: x.contactId },
        },
      );
  } catch (err) {
    console.warn("tag automations not started", err);
  }
}
