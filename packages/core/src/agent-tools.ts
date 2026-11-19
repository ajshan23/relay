import { z } from "zod";

/*
 * An AI agent's own tools: an API call to the business's system, or an MCP server's tools. Shared by
 * the API (validation), the worker and the web app, so it holds no Node-only code.
 *
 * Values in URLs, headers and bodies are templates: {{input.<key>}} is what the agent asks the
 * customer for, and the rest ({{contact.phone}}, {{contact.name}}, {{contact.fields.<key>}},
 * {{chat.id}}) is filled in from the chat, so the agent can never change it.
 */

export const agentToolLimits = {
  /** Tools (API calls + MCP servers) per agent. */
  perAgent: 20,
  /** Tools of one MCP server the agent may use. */
  mcpAllowed: 30,
  timeoutMs: 10_000,
  /** Bigger answers from their system are refused. */
  maxResponseBytes: 1024 * 1024,
  /** A "Yes, go ahead" is accepted this long after the question. */
  confirmMinutes: 30,
} as const;

export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof httpMethods)[number];

/** Something the agent asks the customer for and passes to the tool. */
export const toolInputSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, numbers and _ (e.g. order_number)"),
  description: z.string().trim().max(300).default(""),
  type: z.enum(["text", "number", "boolean"]).default("text"),
  required: z.boolean().default(true),
});
export type ToolInput = z.infer<typeof toolInputSchema>;

const keyValueSchema = z.object({
  key: z.string().trim().min(1).max(100),
  value: z.string().max(2000),
});

export const httpToolConfigSchema = z.object({
  method: z.enum(httpMethods),
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\//i, "Start the address with https://"),
  query: z.array(keyValueSchema).max(20).default([]),
  headers: z.array(keyValueSchema).max(20).default([]),
  /** JSON with {{…}} values, for POST, PUT and PATCH. */
  body: z.string().max(20_000).default(""),
  inputs: z.array(toolInputSchema).max(15).default([]),
  /** Paths the agent may see ("order.status", "items[].name"). Empty: the whole answer. */
  pick: z.array(z.string().max(200)).max(100).default([]),
});
export type HttpToolConfig = z.infer<typeof httpToolConfigSchema>;

/** One tool an MCP server offers, as last listed, and what the business allowed. */
export const mcpServerToolSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(4000).default(""),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }),
  /** The server says the tool only reads. */
  readOnly: z.boolean().default(false),
  allowed: z.boolean().default(false),
  /** Ask the customer before calling it. */
  confirm: z.boolean().default(true),
});
export type McpServerTool = z.infer<typeof mcpServerToolSchema>;

export const mcpToolConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\//i, "Start the address with https://"),
  tools: z.array(mcpServerToolSchema).max(200).default([]),
  /** When the tool list was last read from the server. */
  listedAt: z.string().nullable().default(null),
});
export type McpToolConfig = z.infer<typeof mcpToolConfigSchema>;

/** The key sent with every call, kept encrypted. */
export const toolSecretSchema = z.object({
  header: z.string().trim().min(1).max(100).default("Authorization"),
  value: z.string().min(1).max(4000),
});
export type ToolSecret = z.infer<typeof toolSecretSchema>;

const toolBase = {
  title: z.string().trim().min(2, "Give it a name").max(60),
  description: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
};

/** What the business saves. `secret`: undefined keeps the saved key, null removes it. */
export const agentToolSaveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http"),
    ...toolBase,
    description: z.string().trim().min(5, "Say when the agent should use it").max(1000),
    confirm: z.boolean().default(false),
    config: httpToolConfigSchema,
    secret: toolSecretSchema.nullable().optional(),
  }),
  z.object({
    kind: z.literal("mcp"),
    ...toolBase,
    confirm: z.boolean().default(false),
    config: mcpToolConfigSchema,
    secret: toolSecretSchema.nullable().optional(),
  }),
]);
export type AgentToolSave = z.infer<typeof agentToolSaveSchema>;

/** Values the chat fills in, for the form's "insert" menu. */
export const chatTemplateValues = [
  { token: "{{contact.phone}}", label: "Customer's phone" },
  { token: "{{contact.name}}", label: "Customer's name" },
  { token: "{{chat.id}}", label: "Chat id" },
] as const;

/** Every {{…}} used in a tool's URL, query, headers and body. */
export function templateTokens(config: HttpToolConfig): string[] {
  const all = [
    config.url,
    config.body,
    ...config.query.map((q) => q.value),
    ...config.headers.map((h) => h.value),
  ].join("\n");
  return [...all.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1] as string);
}

/** Problems with a tool's templates, in plain words (an unknown input, an unknown value). */
export function templateProblems(config: HttpToolConfig): string[] {
  const keys = new Set(config.inputs.map((i) => i.key));
  const problems: string[] = [];
  for (const token of new Set(templateTokens(config))) {
    if (token.startsWith("input.")) {
      if (!keys.has(token.slice(6)))
        problems.push(`{{${token}}} isn't one of the things the agent asks for.`);
    } else if (!/^(contact\.(phone|name|fields\.[a-z0-9_]+)|chat\.id)$/.test(token)) {
      problems.push(`{{${token}}} isn't a value Relay knows.`);
    }
  }
  return problems;
}

/** A name the model can call: lowercase words joined by _, at most `max` characters. */
export function toolSlug(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/, "");
  return slug || "tool";
}

// ------------------------------------------------------------------ what the agent may see

/**
 * Every leaf path in an answer ("order.status", "items[].name"), for the "what the agent may see"
 * ticks. Arrays are one path for all their elements.
 */
export function answerPaths(data: unknown, prefix = "", out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 300) return out;
  if (Array.isArray(data)) {
    const sample = data.find((v) => v != null);
    if (sample !== undefined && typeof sample === "object")
      answerPaths(sample, `${prefix}[]`, out, depth + 1);
    else out.push(`${prefix}[]`);
    return out;
  }
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) answerPaths(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    return out;
  }
  if (prefix) out.push(prefix);
  return out;
}

/** Keeps only the ticked paths of an answer (and their parents). No paths: the whole answer. */
export function pickAnswer(data: unknown, paths: string[]): unknown {
  if (!paths.length) return data;
  const wanted = paths.map((p) =>
    p
      .split(".")
      .flatMap((part) => (part.endsWith("[]") ? [part.slice(0, -2), "[]"] : [part]))
      .filter(Boolean),
  );
  return pickNode(data, wanted);
}

function pickNode(data: unknown, paths: string[][]): unknown {
  if (paths.some((p) => p.length === 0)) return data;
  if (Array.isArray(data)) {
    const inner = paths.filter((p) => p[0] === "[]").map((p) => p.slice(1));
    return inner.length ? data.map((v) => pickNode(v, inner)) : undefined;
  }
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      const inner = paths.filter((p) => p[0] === k).map((p) => p.slice(1));
      if (!inner.length) continue;
      const picked = pickNode(v, inner);
      if (picked !== undefined) out[k] = picked;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}
