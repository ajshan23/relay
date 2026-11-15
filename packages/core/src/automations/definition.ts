import { z } from "zod";

/*
 * An automation's definition: what is drafted in the editor and frozen on publish. A run is pinned to
 * the version it started on, so a definition never changes once published (later edits make a new one).
 *
 * The trigger is fixed at the top (node id "trigger", one "next" handle). Steps are nodes keyed by
 * immutable ids; edges connect a node's named handle to the next node. Layout is always automatic, so
 * no positions are stored. schemaVersion lets old drafts be migrated when the format changes.
 */

export const DEFINITION_SCHEMA_VERSION = 1;
export const TRIGGER_NODE_ID = "trigger";

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_received"),
    /** any: every message; keyword: the message matches a keyword; first_message: their very first. */
    mode: z.enum(["any", "keyword", "first_message"]),
    keywords: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    match: z.enum(["exact", "contains"]).optional(),
  }),
  z.object({
    type: z.literal("ad_click"),
    /** Empty means any click-to-WhatsApp ad. */
    adIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  }),
  z.object({ type: z.literal("tag_added"), tagId: z.string().min(1) }),
  z.object({ type: z.literal("run_from_chat") }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

/** Who may enter, and when a run stops early. Frozen with the version, like the steps. */
export const runRulesSchema = z.object({
  /** every_time; once per contact ever; or at most once per cooldownHours. */
  reentry: z.enum(["every_time", "once", "cooldown"]).default("every_time"),
  cooldownHours: z.number().int().min(1).max(8760).optional(),
  /** Don't start while the contact is already in another automation run. */
  skipIfInAnotherRun: z.boolean().default(true),
  /** Don't start when a team member is assigned to the chat. */
  skipIfAssigned: z.boolean().default(true),
  /** Stop when a team member writes in the chat. */
  stopOnAgentReply: z.boolean().default(true),
  /** Stop when the contact opts out. */
  stopOnOptOut: z.boolean().default(true),
});
export type RunRules = z.infer<typeof runRulesSchema>;
export const defaultRunRules: RunRules = runRulesSchema.parse({});

export const nodeIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,40}$/, "Node ids are short letters, digits, _ or -");

export const nodeSchema = z.object({
  id: nodeIdSchema,
  type: z.string().min(1),
  version: z.number().int().min(1),
  config: z.record(z.string(), z.unknown()),
});
export type AutomationNode = z.infer<typeof nodeSchema>;

export const edgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1),
  sourceHandle: z.string().min(1).max(80),
  target: z.string().min(1),
});
export type AutomationEdge = z.infer<typeof edgeSchema>;

export const definitionSchema = z.object({
  schemaVersion: z.literal(DEFINITION_SCHEMA_VERSION),
  trigger: triggerSchema,
  rules: runRulesSchema,
  nodes: z.array(nodeSchema).max(500),
  edges: z.array(edgeSchema).max(2000),
});
export type AutomationDefinition = z.infer<typeof definitionSchema>;

/** A fresh draft: a trigger and nothing else. */
export function emptyDefinition(
  trigger: Trigger = { type: "message_received", mode: "any" },
): AutomationDefinition {
  return { schemaVersion: DEFINITION_SCHEMA_VERSION, trigger, rules: defaultRunRules, nodes: [], edges: [] };
}

/**
 * Brings a stored definition (any older schemaVersion) to the current format. Pure; runs on read and
 * on publish. Add a branch here for each new schemaVersion, never edit an old one.
 */
export function migrateDefinition(raw: unknown): AutomationDefinition {
  const value = (raw ?? {}) as { schemaVersion?: number; rules?: unknown };
  if (value.schemaVersion !== DEFINITION_SCHEMA_VERSION)
    throw new Error(`Unsupported automation schemaVersion ${String(value.schemaVersion)}`);
  return definitionSchema.parse({ ...value, rules: value.rules ?? defaultRunRules });
}
