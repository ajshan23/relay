import {
  agentToolLimits,
  type HttpToolConfig,
  type McpToolConfig,
  type ToolSecret,
  toolSlug,
} from "@relay/core/agent-tools";
import { z } from "zod";
import { toolNames } from "./builtins";
import { catalogToolNames } from "./catalog";
import { defineTool } from "./tools";
import type { AgentTool, RunContext } from "./types";

/*
 * A business's own tools as agent tools: an API call into its system, or the tools of an MCP server
 * it connected. Look-ups run inside the turn like search_knowledge. Changes are "confirm" tools: the
 * model calls them with a short question, the customer taps Yes, and only then does the runtime run
 * them.
 */

export type CustomToolDef =
  | {
      id: string;
      kind: "http";
      name: string;
      title: string;
      description: string;
      confirm: boolean;
      config: HttpToolConfig;
      secret: ToolSecret | null;
    }
  | {
      id: string;
      kind: "mcp";
      name: string;
      title: string;
      description: string;
      config: McpToolConfig;
      secret: ToolSecret | null;
    };

/** Runs one call of a business tool (MCP: which of its tools). Throws in plain words when it fails. */
export type CustomToolRunner = (
  def: CustomToolDef,
  mcpTool: string | null,
  input: Record<string, unknown>,
  ctx: RunContext,
) => Promise<unknown>;

/** The field a confirm tool's call carries: the Yes / No question for the customer. */
export const confirmField = "confirmText";

const confirmNote =
  "It changes something in the business's system, so the customer is asked first: call it with the details and a short confirmText question in the customer's language (e.g. 'Book a table for 2 at 8 pm tonight?'). It runs only after they tap Yes. Never say it's done until you see its result.";

const reserved = new Set<string>([...Object.values(toolNames), ...Object.values(catalogToolNames)]);

/** The schema for an API call's inputs (what the agent asks the customer for). */
export function httpInputSchema(config: HttpToolConfig): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const i of config.inputs) {
    let field: z.ZodType =
      i.type === "number" ? z.number() : i.type === "boolean" ? z.boolean() : z.string().max(500);
    if (i.description) field = field.describe(i.description);
    shape[i.key] = i.required ? field : field.optional();
  }
  return z.object(shape);
}

/** An MCP tool's JSON Schema as zod; anything unreadable becomes "any fields". */
export function mcpInputSchema(schema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(schema as never);
  } catch {
    return z.looseObject({});
  }
}

function withConfirm(schema: z.ZodType): z.ZodType {
  const question = z
    .string()
    .min(2)
    .max(300)
    .describe("The Yes / No question for the customer, in their language");
  if (schema instanceof z.ZodObject) return schema.extend({ [confirmField]: question });
  return z.looseObject({ [confirmField]: question });
}

/** The input as the business's tool gets it (the confirm question removed). */
export function toolArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const { [confirmField]: _q, ...rest } = input as Record<string, unknown>;
  return rest;
}

/** The business's enabled tools, ready for a turn. Names never clash with built-ins or each other. */
export function customTools(defs: CustomToolDef[], run: CustomToolRunner): AgentTool<unknown>[] {
  const taken = new Set(reserved);
  const unique = (base: string) => {
    let name = base.slice(0, 64);
    for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 60)}_${n}`;
    taken.add(name);
    return name;
  };
  const tools: AgentTool<unknown>[] = [];
  for (const def of defs) {
    if (def.kind === "http") {
      const input = httpInputSchema(def.config);
      tools.push(
        defineTool({
          name: unique(def.name),
          kind: def.confirm ? "confirm" : "read",
          description: [
            `${def.title}: a tool of the business.`,
            def.description && `When to use it (the business's words): ${def.description}`,
            def.confirm && confirmNote,
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 1500),
          input: def.confirm ? withConfirm(input) : input,
          ref: { toolId: def.id, title: def.title },
          run: (i, ctx) => run(def, null, toolArguments(i), ctx),
        }),
      );
      continue;
    }
    for (const t of def.config.tools.filter((x) => x.allowed).slice(0, agentToolLimits.mcpAllowed)) {
      const schema = mcpInputSchema(t.inputSchema);
      tools.push(
        defineTool({
          name: unique(`${def.name.slice(0, 30)}__${toolSlug(t.name, 30)}`),
          kind: t.confirm ? "confirm" : "read",
          description: [
            `${t.description || t.name} (from the business's ${def.title}).`,
            def.description && `The business's notes: ${def.description}`,
            t.confirm && confirmNote,
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 1500),
          input: t.confirm ? withConfirm(schema) : schema,
          ref: { toolId: def.id, mcpTool: t.name, title: def.title },
          run: (i, ctx) => run(def, t.name, toolArguments(i), ctx),
        }),
      );
    }
  }
  return tools;
}
