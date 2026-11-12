/*
 * What to do about a Graph API error. Codes from research/01-whatsapp-cloud-api.md.
 *   retryable    try again later (Meta or the network had a problem)
 *   rateLimited  try again later, slower
 *   windowClosed the 24-hour reply window has passed: only a template can be sent
 *   authFailed   the token no longer works: the channel needs reconnecting
 *   permanent    will never succeed as sent (bad recipient, bad content, account problem)
 */

export type GraphErrorKind = "retryable" | "rateLimited" | "windowClosed" | "authFailed" | "permanent";

const rateLimited = new Set([4, 80007, 130429, 131056, 131057]);
const windowClosed = new Set([131047]);
const authFailed = new Set([190, 0, 200, 3, 10, 131005]);
const retryable = new Set([1, 2, 131000, 131016, 133004]);

export function classifyGraphError(code: number | undefined, httpStatus: number): GraphErrorKind {
  if (code !== undefined) {
    if (windowClosed.has(code)) return "windowClosed";
    if (rateLimited.has(code)) return "rateLimited";
    if (authFailed.has(code)) return "authFailed";
    if (retryable.has(code)) return "retryable";
  }
  if (httpStatus === 429) return "rateLimited";
  if (httpStatus === 401) return "authFailed";
  if (httpStatus >= 500) return "retryable";
  return "permanent";
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly kind: GraphErrorKind,
    readonly httpStatus: number,
    readonly code: number | undefined,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/** The request may or may not have reached Meta (timeout, connection reset after sending). Never resend blindly. */
export class GraphUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphUncertainError";
  }
}
