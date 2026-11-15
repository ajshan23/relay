/** Errors a workflow can throw or catch, and the internal signals Kairos uses to stop a replay. */

/** Throw from a step to fail it at once, without retries. */
export class NonRetryableError extends Error {
  readonly nonRetryable = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/** The handler asked for something different from what this run recorded at the same position. */
export class NonDeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonDeterminismError";
  }
}

/** A step used up its retries. Thrown into the handler, which may catch it and take another path. */
export class StepFailedError extends Error {
  readonly step: string;
  readonly error: SerializedError;
  constructor(step: string, error: SerializedError) {
    super(`Step "${step}" failed: ${error.message}`);
    this.name = "StepFailedError";
    this.step = step;
    this.error = error;
  }
}

export type SerializedError = {
  name: string;
  message: string;
  code?: string;
  nonRetryable?: boolean;
  stack?: string;
};

export function serializeError(err: unknown): SerializedError {
  if (err instanceof StepFailedError) return { ...err.error };
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; nonRetryable?: unknown };
    return {
      name: e.name || "Error",
      message: e.message || String(err),
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(e.nonRetryable === true ? { nonRetryable: true } : {}),
      ...(e.stack ? { stack: e.stack.split("\n").slice(0, 12).join("\n") } : {}),
    };
  }
  return { name: "Error", message: typeof err === "string" ? err : (JSON.stringify(err) ?? String(err)) };
}

/**
 * Internal: thrown to unwind the handler when the run must stop executing in this process
 * (it went to sleep, started waiting, lost its claim, or was cancelled). Never stored.
 */
export class KairosControl extends Error {
  readonly kind: "suspended" | "lost" | "cancelled";
  constructor(kind: "suspended" | "lost" | "cancelled") {
    super(`kairos:${kind}`);
    this.name = "KairosControl";
    this.kind = kind;
  }
}

/**
 * True for Kairos's internal unwinding signals. A handler that catches errors broadly must rethrow
 * these: `catch (e) { if (isKairosControl(e)) throw e; … }`. (Kairos also notices if one is swallowed.)
 */
export function isKairosControl(err: unknown): err is KairosControl {
  return err instanceof KairosControl;
}
