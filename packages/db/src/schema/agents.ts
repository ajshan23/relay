import type { HttpToolConfig, McpToolConfig } from "@relay/core/agent-tools";
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { branch } from "./branches";
import { conversation, storedFile } from "./messaging";

/*
 * The AI agent ("Mira"): what one branch teaches it, what it knows, and what it costs.
 *
 * An agent is settings only. Its conversations run as Kairos runs (workflow relay.mira) that hold the
 * chat the same way an automation run does (conversation.automation_run_id), with
 * conversation.ai_agent_id saying which agent it is.
 */

export const agentStatus = pgEnum("ai_agent_status", ["draft", "live", "paused"]);
export const agentModel = pgEnum("ai_agent_model", ["fast", "smart"]);
/** Which AI model family writes the replies (embeddings stay on OpenAI either way). */
export const agentEngine = pgEnum("ai_agent_engine", ["gpt", "claude"]);
/** Voice notes: not listened to, turned into text, or turned into text with the more accurate model (2× credits). */
export const agentVoiceNotes = pgEnum("ai_agent_voice_notes", ["off", "accurate", "best"]);
/** Photos: not looked at, described, or described with the more accurate model (2× credits). */
export const agentPhotos = pgEnum("ai_agent_photos", ["off", "accurate", "best"]);
/** Reply with a voice note: never, when the customer sent one, or to every plain reply. */
export const agentVoiceReplies = pgEnum("ai_agent_voice_replies", ["off", "voice_notes", "always"]);

/** Who gets the chat when the agent hands it over. */
export type AgentHandoff = {
  /** Plain words: when to hand over, beyond "can't help" and "asked for a person". */
  when: string;
  /** null: leave it unassigned for anyone on the branch. */
  assignToUserId: string | null;
  /** Sent to the customer as the agent steps back. */
  message: string;
};

/** Optional working hours for answering chats nobody picked up. Days are 0 = Sunday. */
export type AgentHours = {
  timezone: string;
  days: number[];
  from: string; // "09:00"
  to: string; // "18:00"
} | null;

export const aiAgent = pgTable(
  "ai_agent",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Mira"),
    /** A stored file, or null for the default face. */
    avatarFileId: text("avatar_file_id").references(() => storedFile.id, { onDelete: "set null" }),
    /** One line: "Front desk for Lumen Clinics". */
    role: text("role").notNull().default(""),
    /** The job in plain words: what to do, what to ask, what never to do. */
    instructions: text("instructions").notNull().default(""),
    tone: text("tone").notNull().default("friendly"),
    /** Languages it may answer in; empty means "the customer's language". */
    languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
    model: agentModel("model").notNull().default("fast"),
    engine: agentEngine("engine").notNull().default("gpt"),
    voiceNotes: agentVoiceNotes("voice_notes").notNull().default("accurate"),
    photos: agentPhotos("photos").notNull().default("accurate"),
    voiceReplies: agentVoiceReplies("voice_replies").notNull().default("off"),
    handoff: jsonb("handoff").$type<AgentHandoff>().notNull(),
    /** Answer chats that no automation took and nobody is assigned to. */
    answerUnclaimed: boolean("answer_unclaimed").notNull().default(false),
    hours: jsonb("hours").$type<AgentHours>(),
    /** Contact fields (keys) it may fill in; tags are always allowed. */
    editableFields: text("editable_fields").array().notNull().default(sql`'{}'::text[]`),
    status: agentStatus("status").notNull().default("draft"),
    /** Set once a turn has been tried in the browser (the go-live checklist). */
    triedAt: timestamp("tried_at"),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_agent_branch_idx").on(t.organizationId, t.branchId),
    // At most one live agent per branch answers unclaimed chats.
    uniqueIndex("ai_agent_unclaimed_uidx")
      .on(t.branchId)
      .where(sql`${t.answerUnclaimed} and ${t.status} = 'live'`),
  ],
);

export const knowledgeKind = pgEnum("knowledge_kind", ["text", "qa", "file", "website"]);
export const knowledgeStatus = pgEnum("knowledge_status", ["queued", "indexing", "ready", "failed"]);

/** A Q&A pair, when kind is "qa". */
export type KnowledgeQa = { question: string; answer: string };

/** Something the agent knows: a note, a Q&A pair, a file or a web page. Shared by the branch's agents. */
export const knowledgeSource = pgTable(
  "knowledge_source",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    kind: knowledgeKind("kind").notNull(),
    title: text("title").notNull(),
    /** text: the note itself. */
    body: text("body"),
    qa: jsonb("qa").$type<KnowledgeQa>(),
    fileId: text("file_id").references(() => storedFile.id, { onDelete: "set null" }),
    fileName: text("file_name"),
    url: text("url"),
    status: knowledgeStatus("status").notNull().default("queued"),
    error: text("error"),
    chunkCount: integer("chunk_count").notNull().default(0),
    /** Bumped on every edit; an indexing job for an older revision drops its result. */
    revision: integer("revision").notNull().default(1),
    indexedAt: timestamp("indexed_at"),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("knowledge_source_branch_idx").on(t.organizationId, t.branchId, t.kind)],
);

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** Embedding size of text-embedding-3-small. */
export const embeddingDimensions = 1536;

/** A searchable piece of a source: full-text always, plus an embedding when one could be made. */
export const knowledgeChunk = pgTable(
  "knowledge_chunk",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    tokens: integer("tokens").notNull(),
    embedding: vector("embedding", { dimensions: embeddingDimensions }),
    // "simple" keeps every word (no English stemming), so Hindi, Arabic and mixed text still match.
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', content)`),
  },
  (t) => [
    index("knowledge_chunk_source_idx").on(t.sourceId, t.position),
    index("knowledge_chunk_branch_idx").on(t.organizationId, t.branchId),
    index("knowledge_chunk_tsv_idx").using("gin", t.tsv),
    index("knowledge_chunk_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const aiUsageKind = pgEnum("ai_usage_kind", [
  "reply",
  "embed",
  "try",
  "transcribe",
  "vision",
  "speech",
]);

/** One model call: tokens, cost and credits. Unique per step so a replayed step is never counted twice. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id").references(() => branch.id, { onDelete: "set null" }),
    agentId: text("agent_id").references(() => aiAgent.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversation.id, { onDelete: "set null" }),
    runId: text("run_id"),
    stepKey: text("step_key").notNull(),
    kind: aiUsageKind("kind").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** US dollars × 1,000,000. */
    costMicros: integer("cost_micros").notNull().default(0),
    /** What the business is charged against its monthly allowance. */
    credits: integer("credits").notNull().default(0),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_usage_step_uidx").on(t.stepKey),
    index("ai_usage_org_idx").on(t.organizationId, t.createdAt),
  ],
);

/** A business's monthly AI allowance. No row: the default allowance. */
export const aiCreditAllowance = pgTable("ai_credit_allowance", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  monthlyCredits: integer("monthly_credits").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** A question the agent could not answer from what it knows; "Improve" turns these into answers. */
export const aiGap = pgTable(
  "ai_gap",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => aiAgent.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversation.id, { onDelete: "set null" }),
    stepKey: text("step_key").notNull(),
    question: text("question").notNull(),
    /** Set when someone answered it (the Q&A source made from it) or dismissed it. */
    resolvedAt: timestamp("resolved_at"),
    answerSourceId: text("answer_source_id").references(() => knowledgeSource.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_gap_step_uidx").on(t.stepKey),
    index("ai_gap_branch_idx").on(t.organizationId, t.branchId, t.resolvedAt, t.createdAt),
  ],
);

// ------------------------------------------------------------------ the agent's own tools

export const aiToolKind = pgEnum("ai_tool_kind", ["http", "mcp"]);

/**
 * A tool the business connected: one API call into its system, or an MCP server whose tools it
 * allowed. Settings in `config` (see @relay/core/agent-tools); the key in `secret`, encrypted.
 */
export const aiTool = pgTable(
  "ai_tool",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => aiAgent.id, { onDelete: "cascade" }),
    kind: aiToolKind("kind").notNull(),
    /** What the model calls it (lowercase, unique per agent). */
    name: text("name").notNull(),
    title: text("title").notNull(),
    /** When to use it, in the business's words. */
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    /** API calls: ask the customer to tap Yes before calling. MCP tools say this per tool. */
    confirm: boolean("confirm").notNull().default(false),
    config: jsonb("config").$type<HttpToolConfig | McpToolConfig>().notNull(),
    /** encryptSecret({header, value}), or null for no key. */
    secret: text("secret"),
    /** Last four characters of the key, to show which one is saved. */
    secretHint: text("secret_hint"),
    lastTestOk: boolean("last_test_ok"),
    lastTestedAt: timestamp("last_tested_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_tool_agent_idx").on(t.agentId),
    uniqueIndex("ai_tool_agent_name_uidx").on(t.agentId, t.name),
  ],
);

export const aiToolCallStatus = pgEnum("ai_tool_call_status", ["ok", "error", "declined", "not_sent"]);

/** One call of a tool (or a change not sent: declined by the customer, or a test in Try). */
export const aiToolCall = pgTable(
  "ai_tool_call",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => aiAgent.id, { onDelete: "cascade" }),
    toolId: text("tool_id").references(() => aiTool.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversation.id, { onDelete: "set null" }),
    /** Unique per step, so a replayed step is logged once. Null for tests. */
    stepKey: text("step_key"),
    /** The tool's name as the model called it (MCP: server__tool). */
    name: text("name").notNull(),
    mode: text("mode").$type<"live" | "test">().notNull(),
    status: aiToolCallStatus("status").notNull(),
    httpStatus: integer("http_status"),
    ms: integer("ms"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_tool_call_agent_idx").on(t.agentId, t.createdAt),
    uniqueIndex("ai_tool_call_step_uidx").on(t.stepKey),
  ],
);
