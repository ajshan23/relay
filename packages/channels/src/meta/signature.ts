import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Meta signs every webhook (WhatsApp, Instagram, Messenger) the same way: X-Hub-Signature-256 is
 * "sha256=" + HMAC-SHA256 of the raw request body with the app secret. Verify the raw bytes, never
 * re-serialised JSON.
 */

export function verifyMetaSignature(
  rawBody: Uint8Array | string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Signs a body the way Meta does. For tests and the local webhook simulator. */
export function signMetaPayload(rawBody: Uint8Array | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/**
 * The GET handshake Meta sends when a webhook URL is saved. Returns the challenge to echo back,
 * or null when the request is not a valid subscription for our verify token.
 */
export function verifyMetaHandshake(
  query: Record<string, string | undefined>,
  verifyToken: string,
): string | null {
  if (query["hub.mode"] !== "subscribe") return null;
  const token = query["hub.verify_token"] ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return query["hub.challenge"] ?? null;
}
