import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { createDb } from "./client";
import { storedFile } from "./schema/messaging";
import { type QuotaMode, releaseStorage, reserveStorage } from "./storage-usage";

/*
 * Files are stored once per business: the same bytes (same SHA-256) are one stored_file row and one
 * object, however many messages, templates or broadcasts use them. Per business, never shared across
 * businesses, so a hash never reaches another business's file. Key: files/<org>/<sha256>.
 */

type Db = ReturnType<typeof createDb>["db"];
/** The part of @relay/core's FileStorage this needs. */
type Storage = { put(key: string, bytes: Uint8Array, opts?: { contentType?: string | null }): Promise<void> };

/** SHA-256 as hex. WhatsApp sends it base64; both are accepted. */
export function shaHex(input: string | Uint8Array) {
  if (typeof input !== "string") return createHash("sha256").update(input).digest("hex");
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();
  return Buffer.from(input, "base64").toString("hex");
}

export const fileKey = (organizationId: string, sha: string) => `files/${organizationId}/${sha}`;

/** The business's stored file with this hash, if any (and marks it used). */
export async function findStoredFile(db: Db, organizationId: string, sha256: string) {
  const sha = shaHex(sha256);
  const [row] = await db
    .update(storedFile)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(storedFile.organizationId, organizationId), eq(storedFile.sha256, sha)))
    .returning();
  return row ?? null;
}

/**
 * Stores bytes for a business, or finds the copy it already has. Uploads only when the content is new,
 * and only then counts against the business's storage: `quota: "enforce"` for the business's own
 * uploads (throws StorageFullError past the limit), `"count"` for files customers send (always kept).
 * `newId` makes the row id (passed in so this package needn't depend on @relay/core).
 */
export async function storeFile(
  db: Db,
  storage: Storage,
  input: {
    organizationId: string;
    bytes: Uint8Array;
    mimeType?: string | null;
    newId: () => string;
    quota: QuotaMode;
  },
) {
  const sha = shaHex(input.bytes);
  const existing = await findStoredFile(db, input.organizationId, sha);
  if (existing) return { file: existing, reused: true };
  const size = input.bytes.byteLength;
  // Space first, so a full business never uploads the object at all.
  await reserveStorage(db, input.organizationId, size, input.quota);
  let row: typeof storedFile.$inferSelect | undefined;
  try {
    const key = fileKey(input.organizationId, sha);
    // The object first, then the row: a row never points at missing bytes.
    await storage.put(key, input.bytes, { contentType: input.mimeType });
    [row] = await db
      .insert(storedFile)
      .values({
        id: input.newId(),
        organizationId: input.organizationId,
        sha256: sha,
        sizeBytes: size,
        mimeType: input.mimeType ?? null,
        storageKey: key,
      })
      .onConflictDoNothing()
      .returning();
  } catch (err) {
    await releaseStorage(db, input.organizationId, size);
    throw err;
  }
  // Someone stored the same file at the same moment: use theirs (same key, same bytes), and give the
  // space back, since it is counted once.
  if (!row) await releaseStorage(db, input.organizationId, size);
  const file = row ?? (await findStoredFile(db, input.organizationId, sha));
  if (!file) throw new Error("Stored file vanished");
  return { file, reused: !row };
}
