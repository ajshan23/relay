import {
  buildHttpRequest,
  type CustomToolDef,
  callHttpTool,
  createToolRunner,
  customTools,
  listMcpTools,
  type RunContext,
  ToolCallError,
  type TurnOutcome,
} from "@relay/agent";
import { decryptSecretJson, encryptSecret, newId } from "@relay/core";
import {
  type AgentToolSave,
  agentToolLimits,
  agentToolSaveSchema,
  answerPaths,
  httpToolConfigSchema,
  type McpToolConfig,
  type ToolSecret,
  templateProblems,
  toolSecretSchema,
  toolSlug,
} from "@relay/core/agent-tools";
import { assertPublicUrl } from "@relay/core/net";
import { and, desc, eq, type SQL, schema } from "@relay/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { fail } from "../branches/access";
import { parseBody } from "../branches/routes";
import type { BranchEnv } from "../contacts/shared";

/*
 * The agent's own tools (Tools view):
 *   GET    /api/agents/:id/tools                  its tools (keys never returned) and recent calls
 *   POST   /api/agents/:id/tools                  add an API call or an MCP server
 *   PUT    /api/agents/:id/tools/:toolId          save one (secret: undefined keeps the saved key)
 *   POST   /api/agents/:id/tools/:toolId/enabled  { enabled }
 *   DELETE /api/agents/:id/tools/:toolId
 *   POST   /api/agents/:id/tools/test             run an API call with sample values (really calls it)
 *   POST   /api/agents/:id/tools/mcp              read an MCP server's tools
 */

const T = schema.aiTool;
const C = schema.aiToolCall;

/** A pretend customer for tests and Try (the real chat fills these in). */
export const testContact = { phone: "+971500000000", name: "Test customer", fields: {} };

export type ToolHelpers = {
  canManage: (c: Context<BranchEnv>) => Promise<boolean>;
  agentIn: (c: Context<BranchEnv>, id: string) => SQL | undefined;
};

const secretInput = z.object({
  secret: toolSecretSchema.nullable().optional(),
  toolId: z.string().optional(),
});

export function registerToolRoutes(app: Hono<BranchEnv>, ctx: AppContext, h: ToolHelpers) {
  const net = { allowPrivate: ctx.config.AGENT_TOOLS_ALLOW_PRIVATE === "1" };
  const key = ctx.config.CHANNEL_SECRET_KEY ?? "";

  const toolIn = (c: Context<BranchEnv>, agentId: string, toolId: string) =>
    and(
      eq(T.id, toolId),
      eq(T.agentId, agentId),
      eq(T.organizationId, c.var.access.orgId),
      eq(T.branchId, c.var.branchId),
    );

  async function agentOf(c: Context<BranchEnv>) {
    const [a] = await ctx.db
      .select({ id: schema.aiAgent.id })
      .from(schema.aiAgent)
      .where(h.agentIn(c, c.req.param("id") ?? ""));
    return a ?? null;
  }

  /** The saved key of a tool of this agent, decrypted (null: none). */
  async function savedSecret(c: Context<BranchEnv>, agentId: string, toolId: string | undefined) {
    if (!toolId || !key) return null;
    const [t] = await ctx.db
      .select({ secret: T.secret })
      .from(T)
      .where(toolIn(c, agentId, toolId));
    return t?.secret ? decryptSecretJson<ToolSecret>(t.secret, key) : null;
  }

  /** What the business may see of a tool: everything but the key. */
  const shown = (t: typeof T.$inferSelect) => {
    const { secret, ...rest } = t;
    return { ...rest, hasSecret: !!secret };
  };

  /** Checks a save before it's stored; a message for the business, or null. */
  async function problemWith(body: AgentToolSave): Promise<string | null> {
    try {
      await assertPublicUrl(body.config.url.replace(/\{\{[^}]*\}\}/g, "x"), net);
    } catch (err) {
      return (err as Error).message;
    }
    if (body.kind === "http") {
      const problems = templateProblems(body.config);
      if (problems.length) return problems.join(" ");
      if (new Set(body.config.inputs.map((i) => i.key)).size !== body.config.inputs.length)
        return "Two of the things the agent asks for have the same key.";
    } else if (body.config.tools.filter((t) => t.allowed).length > agentToolLimits.mcpAllowed) {
      return `Allow at most ${agentToolLimits.mcpAllowed} tools of one server.`;
    }
    return null;
  }

  /** A name the model can call, unique among the agent's tools. */
  async function nameFor(agentId: string, title: string, except?: string) {
    const taken = new Set(
      (await ctx.db.select({ id: T.id, name: T.name }).from(T).where(eq(T.agentId, agentId)))
        .filter((t) => t.id !== except)
        .map((t) => t.name),
    );
    const base = toolSlug(title, 40);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    return name;
  }

  const sealed = (secret: ToolSecret) => ({
    secret: encryptSecret(secret, key),
    secretHint: secret.value.slice(-4),
  });

  app.get("/:id/tools", async (c) => {
    const agent = await agentOf(c);
    if (!agent) return fail(c, 404, "not_found");
    const rows = await ctx.db.select().from(T).where(eq(T.agentId, agent.id)).orderBy(T.createdAt);
    const calls = await ctx.db
      .select({
        id: C.id,
        toolId: C.toolId,
        name: C.name,
        mode: C.mode,
        status: C.status,
        httpStatus: C.httpStatus,
        ms: C.ms,
        error: C.error,
        conversationId: C.conversationId,
        createdAt: C.createdAt,
        title: T.title,
      })
      .from(C)
      .leftJoin(T, eq(T.id, C.toolId))
      .where(and(eq(C.agentId, agent.id), eq(C.organizationId, c.var.access.orgId)))
      .orderBy(desc(C.createdAt))
      .limit(50);
    return c.json({
      tools: rows.map(shown),
      calls,
      limits: agentToolLimits,
      ready: !!key,
      canManage: await h.canManage(c),
    });
  });

  app.post("/:id/tools", async (c) => {
    if (!(await h.canManage(c))) return fail(c, 403, "forbidden");
    if (!key)
      return fail(c, 422, "not_configured", "Tools need CHANNEL_SECRET_KEY on the server to keep keys safe.");
    const agent = await agentOf(c);
    if (!agent) return fail(c, 404, "not_found");
    const parsed = await parseBody(c, agentToolSaveSchema);
    if ("error" in parsed) return parsed.error;
    const body = parsed.data;
    const count = (await ctx.db.select({ id: T.id }).from(T).where(eq(T.agentId, agent.id))).length;
    if (count >= agentToolLimits.perAgent)
      return fail(c, 422, "too_many", `An agent can have up to ${agentToolLimits.perAgent} tools.`);
    const problem = await problemWith(body);
    if (problem) return fail(c, 422, "invalid_tool", problem);
    const [row] = await ctx.db
      .insert(T)
      .values({
        id: newId("aiTool"),
        organizationId: c.var.access.orgId,
        branchId: c.var.branchId,
        agentId: agent.id,
        kind: body.kind,
        name: await nameFor(agent.id, body.title),
        title: body.title,
        description: body.description,
        enabled: body.enabled,
        confirm: body.kind === "http" ? body.confirm : false,
        config: body.config,
        ...(body.secret ? sealed(body.secret) : {}),
      })
      .returning();
    return c.json({ tool: row && shown(row) }, 201);
  });

  app.put("/:id/tools/:toolId", async (c) => {
    if (!(await h.canManage(c))) return fail(c, 403, "forbidden");
    if (!key)
      return fail(c, 422, "not_configured", "Tools need CHANNEL_SECRET_KEY on the server to keep keys safe.");
    const agent = await agentOf(c);
    if (!agent) return fail(c, 404, "not_found");
    const parsed = await parseBody(c, agentToolSaveSchema);
    if ("error" in parsed) return parsed.error;
    const body = parsed.data;
    const toolId = c.req.param("toolId");
    const [before] = await ctx.db
      .select()
      .from(T)
      .where(toolIn(c, agent.id, toolId));
    if (!before) return fail(c, 404, "not_found");
    if (before.kind !== body.kind) return fail(c, 422, "invalid_tool", "A tool can't change kind.");
    const problem = await problemWith(body);
    if (problem) return fail(c, 422, "invalid_tool", problem);
    const [row] = await ctx.db
      .update(T)
      .set({
        name: before.title === body.title ? before.name : await nameFor(agent.id, body.title, before.id),
        title: body.title,
        description: body.description,
        enabled: body.enabled,
        confirm: body.kind === "http" ? body.confirm : false,
        config: body.config,
        ...(body.secret
          ? sealed(body.secret)
          : body.secret === null
            ? { secret: null, secretHint: null }
            : {}),
        updatedAt: new Date(),
      })
      .where(eq(T.id, before.id))
      .returning();
    return c.json({ tool: row && shown(row) });
  });

  app.post("/:id/tools/:toolId/enabled", async (c) => {
    if (!(await h.canManage(c))) return fail(c, 403, "forbidden");
    const agent = await agentOf(c);
    if (!agent) return fail(c, 404, "not_found");
    const parsed = await parseBody(c, z.object({ enabled: z.boolean() }));
    if ("error" in parsed) return parsed.error;
    const [row] = await ctx.db
      .update(T)
      .set({ enabled: parsed.data.enabled, updatedAt: new Date() })
      .where(toolIn(c, agent.id, c.req.param("toolId")))
      .returning();
    if (!row) return fail(c, 404, "not_found");
    return c.json({ tool: shown(row) });
  });

  app.delete("/:id/tools/:toolId", async (c) => {
    if (!(await h.canManage(c))) return fail(c, 403, "forbidden");
    const agent = await agentOf(c);
    if (!agent) return fail(c, 404, "not_found");
    const [row] = await ctx.db
      .delete(T)
      .where(toolIn(c, agent.id, c.req.param("toolId")))
      .returning({ id: T.id });
    if (!row) return fail(c, 404, "not_found");
    return c.json({ ok: true });
  });

  /** Runs an API call (saved or not) with sample values: really calls it, so Test is deliberate. */
  app.post("/:id/tools/test", async (c) => {
    if (!(await h.canManage(c))) return fail(c, 403, "forbidden");
    const agent = await agentOf(c);
    if (!agent) return fail(c, 404, "not_found");
    const parsed = await parseBody(
      c,
      secretInput.extend({
        config: httpToolConfigSchema,
        values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const { config, values, toolId } = parsed.data;
    const problems = templateProblems(config);
    if (problems.length) return fail(c, 422, "invalid_tool", problems.join(" "));
    const secret =
      parsed.data.secret === undefined ? await savedSecret(c, agent.id, toolId) : parsed.data.secret;
    const runCtx = testContext(c, agent.id);
    let request: ReturnType<typeof buildHttpRequest>;
    try {
      request = buildHttpRequest(config, secret, values, runCtx);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
    if (secret) request.headers[secret.header] = `•••• ${secret.value.slice(-4)}`;
    const mark = async (ok: boolean) => {
      if (toolId)
        await ctx.db
          .update(T)
          .set({ lastTestOk: ok, lastTestedAt: new Date() })
          .where(toolIn(c, agent.id, toolId));
    };
    try {
      const res = await callHttpTool(config, secret, values, runCtx, net);
      await mark(true);
      return c.json({
        ok: true,
        status: res.status,
        ms: res.ms,
        answer: res.raw,
        paths: answerPaths(res.raw),
        agentSees: res.data,
        request,
      });
    } catch (err) {
      await mark(false);
      const e = err instanceof ToolCallError ? err : null;
      return c.json({
        ok: false,
        error: (err as Error).message,
        status: e?.httpStatus ?? null,
        ms: e?.ms ?? null,
        request,
      });
    }
  });

  /** Reads an MCP server's tools; with toolId, keeps what was already allowed. */
  app.post("/:id/tools/mcp", async (c) => {
    if (!(await h.canManage(c))) return fail(c, 403, "forbidden");
    const agent = await agentOf(c);
    if (!agent) return fail(c, 404, "not_found");
    const parsed = await parseBody(c, secretInput.extend({ url: z.string().trim().min(8).max(2000) }));
    if ("error" in parsed) return parsed.error;
    const { url, toolId } = parsed.data;
    const secret =
      parsed.data.secret === undefined ? await savedSecret(c, agent.id, toolId) : parsed.data.secret;
    try {
      const listed = await listMcpTools(url, secret, net);
      let saved: McpToolConfig["tools"] = [];
      if (toolId) {
        const [t] = await ctx.db
          .select({ config: T.config })
          .from(T)
          .where(toolIn(c, agent.id, toolId));
        saved = (t?.config as McpToolConfig | undefined)?.tools ?? [];
      }
      const tools = listed.map((t) => {
        const was = saved.find((s) => s.name === t.name);
        return was ? { ...t, allowed: was.allowed, confirm: was.confirm } : t;
      });
      return c.json({ ok: true, tools, listedAt: new Date().toISOString() });
    } catch (err) {
      return c.json({ ok: false, error: `Couldn't read the server's tools: ${(err as Error).message}` });
    }
  });

  function testContext(c: Context<BranchEnv>, agentId: string): RunContext {
    return {
      orgId: c.var.access.orgId,
      branchId: c.var.branchId,
      agentId,
      conversationId: null,
      contactId: null,
      mode: "test",
      timezone: "UTC",
      now: new Date(),
      contact: testContact,
    };
  }
}

/**
 * The agent's enabled tools for Try: look-ups really run (and are logged as tests); a change ends the
 * turn with its question, and `wouldSend` says what it would have called.
 */
export async function tryTools(ctx: AppContext, agentId: string) {
  const key = ctx.config.CHANNEL_SECRET_KEY ?? "";
  if (!key) return { tools: [], wouldSend: async () => null };
  const net = { allowPrivate: ctx.config.AGENT_TOOLS_ALLOW_PRIVATE === "1" };
  const rows = await ctx.db
    .select()
    .from(T)
    .where(and(eq(T.agentId, agentId), eq(T.enabled, true)))
    .orderBy(T.createdAt)
    .limit(agentToolLimits.perAgent);
  const defs = rows.map(
    (t) =>
      ({
        ...t,
        secret: t.secret ? decryptSecretJson<ToolSecret>(t.secret, key) : null,
      }) as CustomToolDef,
  );
  const log = (row: Omit<typeof C.$inferInsert, "id" | "mode">) =>
    ctx.db
      .insert(C)
      .values({ id: newId("aiToolCall"), mode: "test", ...row, error: row.error?.slice(0, 500) ?? null })
      .then(
        () => {},
        () => {},
      );
  const tools = customTools(
    defs,
    createToolRunner({
      ...net,
      onCall: (l) =>
        log({
          organizationId: l.ctx.orgId,
          agentId,
          toolId: l.def.id,
          name: l.mcpTool ? `${l.def.name}__${l.mcpTool}` : l.def.name,
          status: l.ok ? "ok" : "error",
          httpStatus: l.httpStatus,
          ms: l.ms,
          error: l.error,
        }),
    }),
  );
  /** What a confirm outcome would call, keys hidden. Logged as "not sent". */
  async function wouldSend(outcome: TurnOutcome, runCtx: RunContext) {
    if (outcome.kind !== "confirm") return null;
    const def = defs.find((d) => d.id === outcome.toolId);
    if (!def) return null;
    await log({
      organizationId: runCtx.orgId,
      agentId,
      toolId: def.id,
      name: outcome.toolName,
      status: "not_sent",
    });
    if (def.kind === "mcp") return { kind: "mcp" as const, tool: outcome.mcpTool, input: outcome.input };
    try {
      const req = buildHttpRequest(def.config, def.secret, outcome.input as Record<string, unknown>, runCtx);
      if (def.secret) req.headers[def.secret.header] = `•••• ${def.secret.value.slice(-4)}`;
      return { kind: "http" as const, ...req };
    } catch (err) {
      return { kind: "http" as const, error: (err as Error).message };
    }
  }
  return { tools, wouldSend };
}
