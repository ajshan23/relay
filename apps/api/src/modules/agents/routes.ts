import { randomUUID } from "node:crypto";
import {
  type AgentProfile,
  aiConfigured,
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
  systemPrompt,
} from "@relay/agent";
import { fileStorage, newId } from "@relay/core";
import { agentPatchSchema, agentSettingsSchema, agentStarters } from "@relay/core/agents";
import {
  aiCredits,
  and,
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
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { enqueue } from "../../lib/enqueue";
import { requireSession } from "../auth/session";
import { branchAccess, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { type BranchEnv, requireBranch } from "../contacts/shared";

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
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx));
  const A = schema.aiAgent;
  const K = schema.knowledgeSource;

  async function canManage(c: Context<BranchEnv>) {
    const found = await branchAccess(ctx, c.var.access, c.var.branchId);
    return found?.role === "manager";
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
    const profile: AgentProfile = {
      name: agent.name,
      role: agent.role,
      businessName: org?.name ?? "the business",
      instructions: agent.instructions,
      tone: agent.tone,
      languages: agent.languages,
      handoffWhen: agent.handoff.when,
    };
    const runCtx: RunContext = {
      orgId,
      branchId: c.var.branchId,
      agentId: agent.id,
      conversationId: null,
      contactId: null,
      mode: "test",
      timezone: branch?.timezone || "UTC",
      now: new Date(),
    };
    const embed = createEmbedder(ctx.config);
    const found: { source: string; text: string }[] = [];
    const tools = builtinTools({
      editableFields: fields,
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
    });
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
      return c.json({
        outcome: result.outcome,
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
    const orgId = c.var.access.orgId;
    const credits = await aiCredits(ctx.db, orgId, defaultMonthlyCredits);
    const U = schema.aiUsage;
    const [totals] = await ctx.db
      .select({
        costMicros: sum(U.costMicros),
        replies: sql<number>`count(*) filter (where ${U.kind} = 'reply' and ${U.credits} > 0)::int`,
        tries: sql<number>`count(*) filter (where ${U.kind} = 'try')::int`,
      })
      .from(U)
      .where(and(eq(U.organizationId, orgId), gte(U.createdAt, monthStart())));
    return c.json({
      credits,
      month: {
        costUsd: Number(totals?.costMicros ?? 0) / 1_000_000,
        replies: totals?.replies ?? 0,
        tries: totals?.tries ?? 0,
      },
    });
  });

  return app;
}
