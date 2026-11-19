import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  agentToolLimits,
  type HttpToolConfig,
  type McpServerTool,
  pickAnswer,
  type ToolSecret,
} from "@relay/core/agent-tools";
import { assertPublicUrl, type NetOptions, publicFetch, readCapped } from "@relay/core/net";
import type { CustomToolDef, CustomToolRunner } from "./custom";
import type { RunContext } from "./types";

/*
 * Calling a business's own system: one API call filled in from a template, or a tool on an MCP
 * server. Only public addresses, a time limit and a size cap; failures come back as errors in plain
 * words the agent can pass on ("Their system answered 404: order not found").
 */

export type ConnectOptions = NetOptions & {
  /** Tests pass a fake; the default only connects to public addresses. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** A failed call, with what the log shows. */
export class ToolCallError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly ms: number,
  ) {
    super(message);
  }
}

const fetchFor = (opts: ConnectOptions) => opts.fetch ?? publicFetch(opts);

// ------------------------------------------------------------------ templates

/** The values a template may use: the agent's inputs and what the chat knows. */
export function templateValues(input: Record<string, unknown>, ctx: RunContext): Record<string, unknown> {
  const values: Record<string, unknown> = {
    "contact.phone": ctx.contact?.phone ?? "",
    "contact.name": ctx.contact?.name ?? "",
    "chat.id": ctx.conversationId ?? "",
  };
  for (const [k, v] of Object.entries(ctx.contact?.fields ?? {})) values[`contact.fields.${k}`] = v;
  for (const [k, v] of Object.entries(input)) values[`input.${k}`] = v;
  return values;
}

const token = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Fills {{…}} in a URL (values URL-encoded), a header (line breaks removed) or a JSON body: inside a
 * string a value is escaped, a bare {{…}} becomes a JSON value (number, true/false, null when missing).
 */
export function fillTemplate(
  text: string,
  values: Record<string, unknown>,
  mode: "url" | "text" | "json",
): string {
  if (mode !== "json")
    return text.replace(token, (_m, key: string) => {
      const v = values[key];
      const s = v == null ? "" : String(v);
      return mode === "url" ? encodeURIComponent(s) : s.replace(/[\r\n]+/g, " ");
    });
  let out = "";
  let last = 0;
  let inString = false;
  for (const m of text.matchAll(token)) {
    const at = m.index ?? 0;
    // Whether this {{…}} sits inside a JSON string: count unescaped quotes since the last one.
    for (let i = last; i < at; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') inString = !inString;
    }
    const v = values[m[1] as string];
    out += text.slice(last, at);
    out += inString ? JSON.stringify(v == null ? "" : String(v)).slice(1, -1) : JSON.stringify(v ?? null);
    last = at + m[0].length;
  }
  return out + text.slice(last);
}

/** The request an API call would send, with nothing sent (for Try, the log and the Test button). */
export function buildHttpRequest(
  config: HttpToolConfig,
  secret: ToolSecret | null,
  input: Record<string, unknown>,
  ctx: RunContext,
): { method: string; url: string; headers: Record<string, string>; body: unknown } {
  const values = templateValues(input, ctx);
  const url = new URL(fillTemplate(config.url, values, "url"));
  for (const q of config.query) {
    const v = fillTemplate(q.value, values, "text");
    if (v !== "") url.searchParams.append(q.key, v);
  }
  const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9" };
  for (const h of config.headers) headers[h.key] = fillTemplate(h.value, values, "text");
  let body: unknown;
  if (config.method !== "GET" && config.body.trim()) {
    const filled = fillTemplate(config.body, values, "json");
    try {
      body = JSON.parse(filled);
    } catch {
      throw new ToolCallError("The tool's body isn't valid JSON once the values are filled in.", null, 0);
    }
    headers["content-type"] = "application/json";
  }
  if (secret) headers[secret.header] = secret.value;
  return { method: config.method, url: url.toString(), headers, body };
}

/** One API call. Returns the answer (only the ticked parts when `pick` is set). */
export async function callHttpTool(
  config: HttpToolConfig,
  secret: ToolSecret | null,
  input: Record<string, unknown>,
  ctx: RunContext,
  opts: ConnectOptions = {},
): Promise<{ status: number; ms: number; data: unknown; raw: unknown }> {
  const started = Date.now();
  const req = buildHttpRequest(config, secret, input, ctx);
  await assertPublicUrl(req.url, opts).catch((err: Error) => {
    throw new ToolCallError(err.message, null, 0);
  });
  let res: Response;
  try {
    res = await fetchFor(opts)(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? agentToolLimits.timeoutMs),
    });
  } catch (err) {
    const ms = Date.now() - started;
    const timedOut = err instanceof Error && /abort|timeout/i.test(`${err.name} ${err.message}`);
    throw new ToolCallError(
      timedOut
        ? "Their system took too long to answer."
        : `Couldn't reach their system (${err instanceof Error ? (err.cause as Error)?.message || err.message : String(err)}).`,
      null,
      ms,
    );
  }
  let text: string;
  try {
    text = await readCapped(res, agentToolLimits.maxResponseBytes);
  } catch (err) {
    throw new ToolCallError((err as Error).message, res.status, Date.now() - started);
  }
  const ms = Date.now() - started;
  const raw = parseAnswer(text);
  if (!res.ok)
    throw new ToolCallError(
      `Their system answered ${res.status}${text.trim() ? `: ${text.trim().slice(0, 300)}` : "."}`,
      res.status,
      ms,
    );
  return { status: res.status, ms, data: pickAnswer(raw, config.pick) ?? null, raw };
}

function parseAnswer(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t.slice(0, 20_000);
  }
}

// ------------------------------------------------------------------ MCP

async function withMcp<T>(
  url: string,
  secret: ToolSecret | null,
  opts: ConnectOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await assertPublicUrl(url, opts);
  const client = new Client({ name: "relay", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: fetchFor(opts),
    requestInit: { headers: secret ? { [secret.header]: secret.value } : {} },
  });
  const timeout = opts.timeoutMs ?? agentToolLimits.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport, { timeout });
        return fn(client);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The MCP server took too long to answer.")), timeout * 2);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

/** The tools an MCP server offers (allowed and confirm are the defaults; the business picks). */
export async function listMcpTools(
  url: string,
  secret: ToolSecret | null,
  opts: ConnectOptions = {},
): Promise<McpServerTool[]> {
  return withMcp(url, secret, opts, async (client) => {
    const out: McpServerTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) {
        const readOnly = t.annotations?.readOnlyHint === true;
        out.push({
          name: t.name,
          description: (t.description ?? t.annotations?.title ?? "").slice(0, 4000),
          inputSchema: t.inputSchema as Record<string, unknown>,
          readOnly,
          allowed: false,
          confirm: !readOnly,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && out.length < 200);
    return out;
  });
}

/** Calls one MCP tool. Its text answers are read as JSON when they are JSON. */
export async function callMcpTool(
  url: string,
  secret: ToolSecret | null,
  name: string,
  args: Record<string, unknown>,
  opts: ConnectOptions = {},
): Promise<{ ms: number; data: unknown }> {
  const started = Date.now();
  let result: Awaited<ReturnType<Client["callTool"]>>;
  try {
    result = await withMcp(url, secret, opts, (client) =>
      client.callTool({ name, arguments: args }, undefined, {
        timeout: opts.timeoutMs ?? agentToolLimits.timeoutMs,
      }),
    );
  } catch (err) {
    throw new ToolCallError(
      `Couldn't use the MCP server (${err instanceof Error ? err.message : String(err)}).`,
      null,
      Date.now() - started,
    );
  }
  const ms = Date.now() - started;
  const texts = Array.isArray(result.content)
    ? (result.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => parseAnswer(c.text as string))
    : [];
  if (result.isError)
    throw new ToolCallError(`The tool failed: ${JSON.stringify(texts).slice(0, 300)}`, null, ms);
  const data = result.structuredContent ?? (texts.length === 1 ? texts[0] : texts);
  return { ms, data };
}

// ------------------------------------------------------------------ one runner for both

export type ToolCallLog = {
  def: CustomToolDef;
  mcpTool: string | null;
  ok: boolean;
  httpStatus: number | null;
  ms: number;
  error: string | null;
  ctx: RunContext;
};

/** Runs any business tool and tells `onCall` how it went (for the Recent calls list). */
export function createToolRunner(
  opts: ConnectOptions & { onCall?: (log: ToolCallLog) => Promise<void> | void } = {},
): CustomToolRunner {
  return async (def, mcpTool, input, ctx) => {
    const log = (l: Omit<ToolCallLog, "def" | "mcpTool" | "ctx">) =>
      Promise.resolve(opts.onCall?.({ def, mcpTool, ctx, ...l })).catch(() => {});
    try {
      if (def.kind === "http") {
        const res = await callHttpTool(def.config, def.secret, input, ctx, opts);
        await log({ ok: true, httpStatus: res.status, ms: res.ms, error: null });
        return res.data;
      }
      const res = await callMcpTool(def.config.url, def.secret, mcpTool ?? "", input, opts);
      await log({ ok: true, httpStatus: null, ms: res.ms, error: null });
      return res.data;
    } catch (err) {
      const e =
        err instanceof ToolCallError
          ? err
          : new ToolCallError(String((err as Error)?.message ?? err), null, 0);
      await log({ ok: false, httpStatus: e.httpStatus, ms: e.ms, error: e.message });
      throw e;
    }
  };
}
