import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
 * Encryption for secrets stored in the database (channel access tokens and similar).
 * AES-256-GCM with a key from CHANNEL_SECRET_KEY. Stored as "v1:<iv>:<tag>:<ciphertext>" in base64url,
 * so the key can be rotated later by adding v2 without breaking rows written with v1.
 */

const VERSION = "v1";

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32)
    throw new Error("CHANNEL_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return key;
}

/** Encrypts a plain-text secret (or an object, as JSON) for storage. */
export function encryptSecret(value: string | Record<string, unknown>, base64Key: string): string {
  const plain = typeof value === "string" ? value : JSON.stringify(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
}

/** Decrypts a value written by encryptSecret. Throws if the value was changed or the key is wrong. */
export function decryptSecret(stored: string, base64Key: string): string {
  const [version, iv, tag, data] = stored.split(":");
  if (version !== VERSION || !iv || !tag || !data) throw new Error("Unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Decrypts a value that was encrypted from an object. */
export function decryptSecretJson<T>(stored: string, base64Key: string): T {
  return JSON.parse(decryptSecret(stored, base64Key)) as T;
}
