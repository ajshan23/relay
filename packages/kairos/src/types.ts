import type { Executor } from "./sql";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Backoff = {
  /** First retry delay. Default 1 s. */
  baseMs?: number;
  /** Each retry waits this many times longer. Default 2. */
  factor?: number;
  /** Longest wait between retries. Default 5 minutes. */
  maxMs?: number;
};

export type StepOptions = {
  /** Retries after the first attempt. Default: the workflow's `retries` (3). */
  retries?: number;
  backoff?: Backoff;
  /** Longest one attempt may take before it counts as failed. Default: the workflow's (60 s). */
  timeoutMs?: number;
};

export type StepInfo = {
  /** Stable for this step of this run, across retries and crashes: pass it to outside APIs to deduplicate. */
  idempotencyKey: string;
  /** 1 for the first attempt. */
  attempt: number;
  /** Aborted when the attempt times out. */
  signal: AbortSignal;
};

export type WaitOptions = {
  /** The event key to wait for, such as "message.received". */
  key: string;
  /** Narrows the events, such as a conversation id. Must match the published scope exactly. */
  scope?: string;
  /** Only events whose payload contains this JSON (Postgres `@>`). */
  filter?: Record<string, Json>;
  /** Give up after this long and return `{ timedOut: true }`. Without it the run waits until cancelled. */
  timeoutMs?: number;
  /**
   * Look back for events from when this earlier step of the run began (its name), instead of from the
   * previous step: e.g. from a pause before a question, so a reply typed during the pause counts.
   * Events this run already used never count twice.
   */
  lookbackFrom?: string;
};

export type WaitResult<P = Json> =
  | { timedOut: false; event: { id: string; key: string; scope: string; payload: P; createdAt: string } }
  | { timedOut: true };

export interface WorkflowContext {
  readonly runId: string;
  readonly tenantId: string;
  readonly workflow: string;
  readonly version: number;
  readonly labels: Record<string, Json>;
  /** Runs `fn` once and records its result; a replay returns the recorded result without running it. */
  step<T>(name: string, fn: (info: StepInfo) => Promise<T> | T, options?: StepOptions): Promise<T>;
  /** Sleeps durably: the process lets go of the run and any worker picks it up when the time comes. */
  sleep(name: string, ms: number): Promise<void>;
  sleepUntil(name: string, until: Date): Promise<void>;
  /** Waits durably for a published event (or the timeout). An event published just before the wait counts. */
  waitForEvent<P = Json>(name: string, options: WaitOptions): Promise<WaitResult<P>>;
}

export type WorkflowHandler<I, O> = (ctx: WorkflowContext, input: I) => Promise<O>;

export type WorkflowOptions = {
  name: string;
  /** Bump when the handler changes in a way old runs can't replay. Old versions keep running on old code. */
  version: number;
  /** Default retries for each step. Default 3. */
  retries?: number;
  backoff?: Backoff;
  /** Default timeout for one step attempt. Default 60 s. */
  stepTimeoutMs?: number;
};

export type Workflow<I = unknown, O = unknown> = Required<Omit<WorkflowOptions, "backoff">> & {
  backoff: Required<Backoff>;
  key: string;
  handler: WorkflowHandler<I, O>;
};

export type StartOptions = {
  tenantId: string;
  /** Runs with the same serial key never execute at the same time (e.g. a conversation id). */
  serialKey?: string;
  /** A second start with the same key (per tenant and workflow) returns the first run instead. */
  idempotencyKey?: string;
  /** Higher runs first within a tenant. Default 0. */
  priority?: number;
  /** Start later. */
  delayMs?: number;
  /** Searchable tags for the dashboard and your own queries, e.g. { automationId }. */
  labels?: Record<string, Json>;
  /** Run inside your own transaction, so the run exists only if it commits. */
  executor?: Executor;
};

export type StartResult = { runId: string; created: boolean };

export type PublishInput = {
  tenantId: string;
  key: string;
  scope?: string;
  payload?: Json;
  /** Publishing the same dedupe key twice (per tenant) is a no-op. */
  dedupeKey?: string;
};

export type PublishResult = { eventId: string | null; duplicate: boolean; matchedRuns: string[] };

export type RunStatus = "queued" | "running" | "sleeping" | "waiting" | "completed" | "failed" | "cancelled";

export type RunRow = {
  id: string;
  tenant_id: string;
  workflow: string;
  version: number;
  serial_key: string | null;
  status: RunStatus;
  input: Json;
  output: Json;
  error: Json;
  idempotency_key: string | null;
  labels: Record<string, Json>;
  priority: number;
  claims: number;
  claim_losses: number;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  updated_at: Date;
  finished_at: Date | null;
};

export type StepRow = {
  run_id: string;
  seq: number;
  kind: "step" | "sleep" | "wait";
  name: string;
  idem_hash: string;
  status: "completed" | "failed" | "retrying" | "waiting";
  result: Json;
  error: Json;
  attempt: number;
  wake_at: Date | null;
  started_at: Date;
  completed_at: Date | null;
};

export type Logger = (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => void;
