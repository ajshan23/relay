import { randomUUID } from "node:crypto";
import {
  type AgentProfile,
  aiConfigured,
  type BookingDeps,
  bookingToolRef,
  builtinTools,
  type ChatLine,
  chatMessages,
  contextNote,
  costMicros,
  createEmbedder,
  createModelCaller,
  creditsFor,
  defaultMonthlyCredits,
  modelFor,
  type RunContext,
  runTurn,
  searchTerms,
  serviceOf,
  speechConfigured,
  systemPrompt,
} from "@relay/agent";
import { fileStorage, newId } from "@relay/core";
import { agentPatchSchema, agentSettingsSchema, agentStarters } from "@relay/core/agents";
import { bookingTimeLabel, zonedTime } from "@relay/core/bookings";
import {
  agentFreeTimes,
  aiCredits,
  and,
  bookableServices,
  bookingSettingsOf,
  calendarDepsFrom,
  catalogAgentDeps,
  catalogCards,
  catalogShape,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  monthStart,
  recordAiUsage,
  schema,
  searchKnowledge,
  sql,
  storeFile,
  sum,
} from "@relay/db";
import { catalogEmbeddingDimensions } from "@relay/db/schema";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { enqueue } from "../../lib/enqueue";
import { requireSession } from "../auth/session";
import { can, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { type BranchEnv, canIn, requireBranch, requirePermission } from "../contacts/shared";
import { assignableUsers } from "../conversations/access";
import { registerToolRoutes, testContact, tryTools } from "./tools";

/** What a booking question in Try would do on Yes, in words. */
function bookingWouldDo(
  outcome: { toolName: string; input: unknown },
  services: { variantId: string; itemId: string; title: string }[],
  timezone: string,
) {
  const i = (outcome.input ?? {}) as { service?: string; date?: string; time?: string; reference?: string };
  const service = i.service ? serviceOf(services as never, i.service)?.title : undefined;
  const when =
    i.date && i.time
      ? bookingTimeLabel(
          zonedTime(i.date, Number(i.time.slice(0, 2)) * 60 + Number(i.time.slice(3, 5)), timezone),
          timezone,
        )
      : "";
  const text =
    outcome.toolName === "cancel_booking"
      ? `cancel booking ${i.reference ?? ""}`
      : outcome.toolName === "move_booking"
        ? `move booking ${i.reference ?? ""} to ${when}`
        : `book ${service ?? "the service"} for ${when}`;
  return { kind: "booking" as const, text: text.trim() };
}

/*
 * The AI agent ("Mira") of the selected branch (?branch=):
 *   GET    /api/agents                    the branch's agents, credits, whether AI is set up
 *   POST   /api/agents                    create one (from a starter or blank)
 *   PATCH  /api/agents/:id                Teach / Go live settings
 *   POST   /api/agents/:id/status         { status: live | paused | draft }
 *   DELETE /api/agents/:id
 *   POST   /api/agents/:id/try            one turn on a pretend chat (nothing reaches WhatsApp)
 *   GET    /api/agents/knowledge          what the branch's agents know
 *   POST   /api/agents/knowledge          a note, a Q&A pair or a web page
 *   POST   /api/agents/knowledge/file     a PDF, Word or text file (multipart "file")
 *   PATCH  /api/agents/knowledge/:id      edit (re-indexed)
 *   POST   /api/agents/knowledge/:id/reindex
 *   DELETE /api/agents/knowledge/:id
 *   GET    /api/agents/gaps               questions the agent couldn't answer
 *   POST   /api/agents/gaps/:id/answer    { answer } → a Q&A source; POST /api/agents/gaps/:id/dismiss
 *   GET    /api/agents/usage              this month's credits and cost
 *   …/api/agents/:id/tools                 the agent's own tools (see tools.ts)
 * Owners, admins and the branch's managers may change things; anyone in the branch may look.
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const fileTypes: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

const knowledgeBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    title: z.string().trim().min(1, "Give it a title").max(120),
    body: z.string().trim().min(1, "Write something").max(50_000),
  }),
  z.object({
    kind: z.literal("qa"),
    question: z.string().trim().min(3, "Write the question").max(500),
    answer: z.string().trim().min(1, "Write the answer").max(4000),
  }),
  z.object({
    kind: z.literal("website"),
    url: z
      .string()
      .trim()
      .refine(
        (u) => URL.canParse(u) && /^https?:\/\//i.test(u),
        "Enter a full web address, starting with https://",
      ),
  }),
]);

const tryBody = z.object({
  messages: z
    .array(z.object({ from: z.enum(["customer", "agent"]), text: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(40),
  contactName: z.string().max(80).optional(),
});

export function agentRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx), requirePermission("agent.view"));
  const A = schema.aiAgent;
  const K = schema.knowledgeSource;

  async function canManage(c: Context<BranchEnv>) {
    return canIn(c, "agent.manage");
  }
  const agentIn = (c: Context<BranchEnv>, id: string) =>
    and(eq(A.id, id), eq(A.organizationId, c.var.access.orgId), eq(A.branchId, c.var.branchId));
  const sourceIn = (c: Context<BranchEnv>, id: string) =>
    and(eq(K.id, id), eq(K.organizationId, c.var.access.orgId), eq(K.branchId, c.var.branchId));

  /** Queues indexing for a source's current revision. */
  const index = (sourceId: string, revision: number) =>
    enqueue(
      ctx.queues.knowledge,
      "index",
      { sourceId, revision },
      { jobId: `index_${sourceId}_${revision}`, attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
    );

  /** A unique answer-unclaimed violation (another live agent in this branch already does it). */
  async function saveAgent(c: Context<BranchEnv>, run: () => Promise<Response>) {
    try {
      return await run();
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      if (e.code === "23505" || e.cause?.code === "23505")
        return fail(
          c,
          409,
          "unclaimed_taken",
          "Another live agent in this branch already answers chats nobody picked up.",
        );
      throw err;
    }
  }

  // ------------------------------------------------------------------ agents

  app.get("/", async (c) => {
    const agents = await ctx.db
      .select()
      .from(A)
      .where(and(eq(A.organizationId, c.var.access.orgId), eq(A.branchId, c.var.branchId)))
      .orderBy(A.createdAt);
    const [sources] = await ctx.db
      .select({
        ready: sql<number>`count(*) filter (where ${K.status} = 'ready')::int`,
        all: sql<number>`count(*)::int`,
      })
      .from(K)
      .where(and(eq(K.organizationId, c.var.access.orgId), eq(K.branchId, c.var.branchId)));
    const credits = await aiCredits(ctx.db, c.var.access.orgId, defaultMonthlyCredits);
    return c.json({
      agents,
      knowledge: sources ?? { ready: 0, all: 0 },
      credits,
      aiReady: aiConfigured(ctx.config),
      voiceReady: speechConfigured(ctx.config),
      canManage: await canManage(c),
      starters: agentStarters,
    });
  });

  app.post("/", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({ starter: z.string().optional(), name: z.string().trim().max(40).optional() }),
    );
    if ("error" in parsed) return parsed.error;
    const starter = agentStarters.find((s) => s.id === parsed.data.starter);
    const settings = agentSettingsSchema.parse({
      name: parsed.data.name || "Mira",
      role: starter?.role ?? "",
      instructions: starter?.instructions ?? "",
      handoff: {},
    });
    const [row] = await ctx.db
      .insert(A)
      .values({
        id: newId("aiAgent"),
        organizationId: c.var.access.orgId,
        branchId: c.var.branchId,
        createdByUserId: c.var.access.userId,
        ...settings,
      })
      .returning();
    return c.json({ agent: row }, 201);
  });

  app.patch("/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, agentPatchSchema);
    if ("error" in parsed) return parsed.error;
    // Mira hands chats to someone who can reply in this branch.
    const handTo = parsed.data.handoff?.assignToUserId;
    if (handTo) {
      const people = await assignableUsers(ctx, c.var.access.orgId, c.var.branchId);
      if (!people.some((p) => p.id === handTo))
        return fail(c, 422, "invalid_assignee", "That person can't reply to chats in this branch.");
    }
    const set = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    return saveAgent(c, async () => {
      const [row] = await ctx.db
        .update(A)
        .set({ ...set, updatedAt: new Date() })
        .where(agentIn(c, c.req.param("id")))
        .returning();
      if (!row) return fail(c, 404, "not_found");
      return c.json({ agent: row });
    });
  });

  app.post("/:id/status", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, z.object({ status: z.enum(["draft", "live", "paused"]) }));
    if ("error" in parsed) return parsed.error;
    if (parsed.data.status === "live") {
      const [a] = await ctx.db
        .select()
        .from(A)
        .where(agentIn(c, c.req.param("id")));
      if (!a) return fail(c, 404, "not_found");
      if (!a.instructions.trim() && !a.role.trim())
        return fail(c, 422, "not_ready", "Tell the agent what its job is (Teach) before putting it live.");
      if (!aiConfigured(ctx.config))
        return fail(c, 422, "ai_not_configured", "The AI isn't set up on this server yet (no AI key).");
    }
    return saveAgent(c, async () => {
      const [row] = await ctx.db
        .update(A)
        .set({ status: parsed.data.status, updatedAt: new Date() })
        .where(agentIn(c, c.req.param("id")))
        .returning();
      if (!row) return fail(c, 404, "not_found");
      return c.json({ agent: row });
    });
  });

  app.delete("/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [row] = await ctx.db
      .delete(A)
      .where(agentIn(c, c.req.param("id")))
      .returning({ id: A.id });
    if (!row) return fail(c, 404, "not_found");
    return c.json({ ok: true });
  });

  /** One turn of the real harness on a pretend chat: the reply plus what the agent looked at. */
  app.post("/:id/try", async (c) => {
    if (!canIn(c, "agent.try"))
      return fail(c, 403, "forbidden", "You don't have access to try the AI agent.");
    const parsed = await parseBody(c, tryBody);
    if ("error" in parsed) return parsed.error;
    if (!aiConfigured(ctx.config))
      return fail(c, 422, "ai_not_configured", "The AI isn't set up on this server yet (no AI key).");
    const [agent] = await ctx.db
      .select()
      .from(A)
      .where(agentIn(c, c.req.param("id")));
    if (!agent) return fail(c, 404, "not_found");
    const orgId = c.var.access.orgId;
    const [org] = await ctx.db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId));
    const [branch] = await ctx.db
      .select({ timezone: schema.branch.timezone })
      .from(schema.branch)
      .where(eq(schema.branch.id, c.var.branchId));
    const fields = agent.editableFields.length
      ? await ctx.db
          .select({ key: schema.contactField.key, label: schema.contactField.label })
          .from(schema.contactField)
          .where(
            and(
              eq(schema.contactField.organizationId, orgId),
              inArray(schema.contactField.key, agent.editableFields),
            ),
          )
      : [];
    const own = await tryTools(ctx, agent.id);
    // Booking in Try: free times are real; booking, moving and cancelling are never carried out.
    const bookingSetup = await bookingSettingsOf(ctx.db, orgId, c.var.branchId);
    const services = bookingSetup.enabled
      ? await bookableServices(ctx.db, { organizationId: orgId, branchId: c.var.branchId })
      : [];
    const notInTry = async (): Promise<never> => {
      throw new Error("Changes aren't made in Try.");
    };
    const booking: BookingDeps | undefined = services.length
      ? {
          timezone: bookingSetup.timezone,
          services,
          findTimes: ({ variantId, date, partOfDay }) =>
            agentFreeTimes(ctx.db, {
              calendar: calendarDepsFrom(ctx.config),
              organizationId: orgId,
              branchId: c.var.branchId,
              variantId,
              timezone: bookingSetup.timezone,
              ...(date ? { date } : {}),
              ...(partOfDay ? { partOfDay } : {}),
              now: new Date(),
            }),
          book: notInTry,
          move: notInTry,
          cancel: notInTry,
          myBookings: async () => ({ bookings: [] }),
        }
      : undefined;
    const profile: AgentProfile = {
      ownTools: own.tools.length > 0,
      booking: !!booking,
      name: agent.name,
      role: agent.role,
      businessName: org?.name ?? "the business",
      instructions: agent.instructions,
      tone: agent.tone,
      languages: agent.languages,
      handoffWhen: agent.handoff.when,
    };
    const shape = await catalogShape(ctx.db, orgId, c.var.branchId);
    profile.catalog = !!shape;
    const runCtx: RunContext = {
      orgId,
      branchId: c.var.branchId,
      agentId: agent.id,
      conversationId: null,
      contactId: null,
      mode: "test",
      timezone: branch?.timezone || "UTC",
      now: new Date(),
      contact: { ...testContact, name: parsed.data.contactName ?? testContact.name },
    };
    const embed = createEmbedder(ctx.config);
    const embedCatalog = createEmbedder(ctx.config, { dimensions: catalogEmbeddingDimensions });
    const found: { source: string; text: string }[] = [];
    const tools = [
      ...builtinTools({
        ...(booking ? { booking } : {}),
        editableFields: fields,
        ...(shape
          ? {
              catalog: catalogAgentDeps(ctx.db, {
                organizationId: orgId,
                branchId: c.var.branchId,
                shape,
                embed: async (text) => (await embedCatalog([text])).embeddings[0] ?? null,
                terms: searchTerms,
              }),
            }
          : {}),
        searchKnowledge: async (query) => {
          const embedding = (await embed([query]).catch(() => null))?.embeddings[0] ?? null;
          const hits = await searchKnowledge(ctx.db, {
            orgId,
            branchId: c.var.branchId,
            terms: searchTerms(query),
            embedding,
          });
          const out = hits.map((h) => ({ source: h.title, text: h.content }));
          found.push(...out);
          return out;
        },
        // A test never changes a real contact: say what would be saved.
        updateContact: async (change) =>
          ({
            saved: [...Object.keys(change.fields), ...change.addTags.map((t) => `tag:${t}`)],
            test: true,
          }) as never,
      }),
      ...own.tools,
    ];
    const lines: ChatLine[] = parsed.data.messages.map((m) => ({ from: m.from, text: m.text }));
    const tryId = randomUUID();
    try {
      const result = await runTurn({
        model: modelFor(agent.model, process.env),
        system: systemPrompt(profile),
        messages: chatMessages(
          lines,
          contextNote(runCtx, { name: parsed.data.contactName ?? "Test customer" }, agent.languages),
        ),
        tools,
        ctx: runCtx,
        callModel: createModelCaller(ctx.config, { cacheKey: agent.id }),
        onModelCall: (r, i) =>
          recordAiUsage(ctx.db, {
            id: newId("aiUsage"),
            organizationId: orgId,
            branchId: c.var.branchId,
            agentId: agent.id,
            stepKey: `try:${tryId}:model${i}`,
            kind: "try",
            model: r.model,
            inputTokens: r.usage.inputTokens,
            cachedTokens: r.usage.cachedTokens,
            outputTokens: r.usage.outputTokens,
            costMicros: costMicros(r.model, r.usage),
            credits: creditsFor("try", i),
            latencyMs: r.latencyMs,
          }),
      });
      await ctx.db.update(A).set({ triedAt: new Date() }).where(eq(A.id, agent.id));
      // Items Mira chose to show, as the cards the customer would get.
      const shownIds =
        result.outcome.kind === "items"
          ? result.outcome.itemIds
          : result.outcome.kind === "media"
            ? [result.outcome.itemId]
            : [];
      const cards = shownIds.length
        ? await catalogCards(ctx.db, { organizationId: orgId, branchId: c.var.branchId, ids: shownIds })
        : [];
      return c.json({
        outcome: result.outcome,
        wouldSend:
          result.outcome.kind === "confirm" && result.outcome.toolId === bookingToolRef.toolId
            ? bookingWouldDo(result.outcome, services, bookingSetup.timezone)
            : await own.wouldSend(result.outcome, runCtx),
        cards,
        tools: result.trace.tools.map((t) => ({ name: t.name, input: t.input, ok: t.result.ok })),
        knowledge: found,
        usage: result.trace.calls.map((call) => ({
          model: call.model,
          ...call.usage,
          costMicros: costMicros(call.model, call.usage),
          latencyMs: call.latencyMs,
        })),
      });
    } catch (err) {
      console.warn("agent try failed", err);
      return fail(c, 502, "ai_failed", `The AI didn't answer: ${(err as Error).message.slice(0, 200)}`);
    }
  });

  registerToolRoutes(app, ctx, { canManage, agentIn });

  // ------------------------------------------------------------------ knowledge

  app.get("/knowledge", async (c) => {
    const rows = await ctx.db
      .select({
        id: K.id,
        kind: K.kind,
        title: K.title,
        body: K.body,
        qa: K.qa,
        url: K.url,
        fileName: K.fileName,
        status: K.status,
        error: K.error,
        chunkCount: K.chunkCount,
        updatedAt: K.updatedAt,
        indexedAt: K.indexedAt,
      })
      .from(K)
      .where(and(eq(K.organizationId, c.var.access.orgId), eq(K.branchId, c.var.branchId)))
      .orderBy(desc(K.updatedAt));
    return c.json({ sources: rows });
  });

  app.post("/knowledge", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, knowledgeBody);
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    const [row] = await ctx.db
      .insert(K)
      .values({
        id: newId("knowledgeSource"),
        organizationId: c.var.access.orgId,
        branchId: c.var.branchId,
        createdByUserId: c.var.access.userId,
        kind: b.kind,
        ...(b.kind === "text" ? { title: b.title, body: b.body } : {}),
        ...(b.kind === "qa" ? { title: b.question, qa: { question: b.question, answer: b.answer } } : {}),
        ...(b.kind === "website" ? { title: b.url, url: b.url } : {}),
      } as typeof K.$inferInsert)
      .returning();
    if (!row) return fail(c, 500, "not_saved");
    await index(row.id, row.revision);
    return c.json({ source: row }, 201);
  });

  app.post("/knowledge/file", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File)) return fail(c, 422, "file_required", "Choose a file.");
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = fileTypes[ext];
    if (!mimeType) return fail(c, 415, "unsupported_file", "Use a PDF, Word (.docx), or text file.");
    if (file.size > MAX_FILE_BYTES) return fail(c, 413, "file_too_large", "Files can be up to 20 MB.");
    const { file: stored } = await storeFile(ctx.db, fileStorage(), {
      organizationId: c.var.access.orgId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType,
      newId: () => newId("storedFile"),
      quota: "enforce",
    });
    const name = file.name.slice(0, 200);
    const [row] = await ctx.db
      .insert(K)
      .values({
        id: newId("knowledgeSource"),
        organizationId: c.var.access.orgId,
        branchId: c.var.branchId,
        createdByUserId: c.var.access.userId,
        kind: "file",
        title: name.replace(/\.[^.]+$/, ""),
        fileId: stored.id,
        fileName: name,
      })
      .returning();
    if (!row) return fail(c, 500, "not_saved");
    await index(row.id, row.revision);
    return c.json({ source: row }, 201);
  });

  app.patch("/knowledge/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({
        title: z.string().trim().min(1).max(120).optional(),
        body: z.string().trim().min(1).max(50_000).optional(),
        question: z.string().trim().min(3).max(500).optional(),
        answer: z.string().trim().min(1).max(4000).optional(),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const [cur] = await ctx.db
      .select()
      .from(K)
      .where(sourceIn(c, c.req.param("id")));
    if (!cur) return fail(c, 404, "not_found");
    const b = parsed.data;
    const qa =
      cur.kind === "qa"
        ? { question: b.question ?? cur.qa?.question ?? "", answer: b.answer ?? cur.qa?.answer ?? "" }
        : undefined;
    const [row] = await ctx.db
      .update(K)
      .set({
        ...(b.title ? { title: b.title } : {}),
        ...(cur.kind === "text" && b.body ? { body: b.body } : {}),
        ...(qa ? { qa, title: qa.question } : {}),
        status: "queued",
        revision: sql`${K.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(K.id, cur.id))
      .returning();
    if (!row) return fail(c, 404, "not_found");
    await index(row.id, row.revision);
    return c.json({ source: row });
  });

  app.post("/knowledge/:id/reindex", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [row] = await ctx.db
      .update(K)
      .set({ status: "queued", error: null, revision: sql`${K.revision} + 1`, updatedAt: new Date() })
      .where(sourceIn(c, c.req.param("id")))
      .returning();
    if (!row) return fail(c, 404, "not_found");
    await index(row.id, row.revision);
    return c.json({ source: row });
  });

  app.delete("/knowledge/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [row] = await ctx.db
      .delete(K)
      .where(sourceIn(c, c.req.param("id")))
      .returning({ id: K.id });
    if (!row) return fail(c, 404, "not_found");
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ gaps and usage

  const G = schema.aiGap;
  app.get("/gaps", async (c) => {
    const rows = await ctx.db
      .select({ id: G.id, question: G.question, conversationId: G.conversationId, createdAt: G.createdAt })
      .from(G)
      .where(
        and(eq(G.organizationId, c.var.access.orgId), eq(G.branchId, c.var.branchId), isNull(G.resolvedAt)),
      )
      .orderBy(desc(G.createdAt))
      .limit(200);
    return c.json({ gaps: rows });
  });

  app.post("/gaps/:id/answer", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({
        question: z.string().trim().min(3).max(500).optional(),
        answer: z.string().trim().min(1, "Write the answer").max(4000),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const gapWhere = and(
      eq(G.id, c.req.param("id")),
      eq(G.organizationId, c.var.access.orgId),
      eq(G.branchId, c.var.branchId),
    );
    const [gap] = await ctx.db.select().from(G).where(gapWhere);
    if (!gap) return fail(c, 404, "not_found");
    const question = parsed.data.question ?? gap.question;
    const [source] = await ctx.db
      .insert(K)
      .values({
        id: newId("knowledgeSource"),
        organizationId: c.var.access.orgId,
        branchId: c.var.branchId,
        createdByUserId: c.var.access.userId,
        kind: "qa",
        title: question,
        qa: { question, answer: parsed.data.answer },
      })
      .returning();
    if (!source) return fail(c, 500, "not_saved");
    await ctx.db.update(G).set({ resolvedAt: new Date(), answerSourceId: source.id }).where(gapWhere);
    await index(source.id, source.revision);
    return c.json({ source }, 201);
  });

  app.post("/gaps/:id/dismiss", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    await ctx.db
      .update(G)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(G.id, c.req.param("id")),
          eq(G.organizationId, c.var.access.orgId),
          eq(G.branchId, c.var.branchId),
        ),
      );
    return c.json({ ok: true });
  });

  app.get("/usage", async (c) => {
    if (!can(c.var.access, "usage.view")) return fail(c, 403, "forbidden");
    const orgId = c.var.access.orgId;
    const credits = await aiCredits(ctx.db, orgId, defaultMonthlyCredits);
    const U = schema.aiUsage;
    const [totals] = await ctx.db
      .select({
        costMicros: sum(U.costMicros),
        replies: sql<number>`count(*) filter (where ${U.kind} = 'reply' and ${U.credits} > 0)::int`,
        tries: sql<number>`count(*) filter (where ${U.kind} = 'try')::int`,
        voiceNotes: sql<number>`count(*) filter (where ${U.kind} = 'transcribe')::int`,
        voiceNoteCredits: sql<number>`coalesce(sum(${U.credits}) filter (where ${U.kind} = 'transcribe'), 0)::int`,
        photos: sql<number>`count(*) filter (where ${U.kind} = 'vision')::int`,
        photoCredits: sql<number>`coalesce(sum(${U.credits}) filter (where ${U.kind} = 'vision'), 0)::int`,
        voiceReplies: sql<number>`count(*) filter (where ${U.kind} = 'speech')::int`,
        voiceReplyCredits: sql<number>`coalesce(sum(${U.credits}) filter (where ${U.kind} = 'speech'), 0)::int`,
      })
      .from(U)
      .where(and(eq(U.organizationId, orgId), gte(U.createdAt, monthStart())));
    return c.json({
      credits,
      month: {
        costUsd: Number(totals?.costMicros ?? 0) / 1_000_000,
        replies: totals?.replies ?? 0,
        tries: totals?.tries ?? 0,
        voiceNotes: totals?.voiceNotes ?? 0,
        voiceNoteCredits: totals?.voiceNoteCredits ?? 0,
        photos: totals?.photos ?? 0,
        photoCredits: totals?.photoCredits ?? 0,
        voiceReplies: totals?.voiceReplies ?? 0,
        voiceReplyCredits: totals?.voiceReplyCredits ?? 0,
      },
    });
  });

  return app;
}
