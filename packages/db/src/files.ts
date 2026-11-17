import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { createDb } from "./client";
import { aiAgent, knowledgeSource } from "./schema/agents";
import { catalogMedia } from "./schema/catalog";
import { attachment, storedFile } from "./schema/messaging";
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

/**
 * True (SQL) when something still points at stored file `f`: a message attachment (chats, templates,
 * automations), a knowledge file, an AI agent's picture, a catalogue gallery file. Add any new table
 * that keeps a stored_file id here, or the sweep deletes its files.
 */
export const fileInUse = sql`(
  exists (select 1 from ${attachment} a where a.file_id = f.id)
  or exists (select 1 from ${knowledgeSource} k where k.file_id = f.id)
  or exists (select 1 from ${aiAgent} g where g.avatar_file_id = f.id)
  or exists (select 1 from ${catalogMedia} m where m.file_id = f.id))`;

/**
 * Deletes a business's stored file right away if nothing uses it any more (and gives the space back),
 * instead of waiting for the nightly sweep. Returns whether it was deleted.
 */
export async function deleteFileIfUnused(
  db: Db,
  storage: { delete(key: string): Promise<void> },
  organizationId: string,
  fileId: string,
) {
  const res = await db.execute(sql`
    delete from ${storedFile} f
    where f.id = ${fileId} and f.organization_id = ${organizationId} and not ${fileInUse}
    returning f.storage_key, f.preview_key, f.size_bytes`);
  const row = (Array.isArray(res) ? res[0] : undefined) as
    | { storage_key: string; preview_key: string | null; size_bytes: string | number }
    | undefined;
  if (!row) return false;
  await releaseStorage(db, organizationId, Number(row.size_bytes));
  await storage.delete(row.storage_key).catch(() => {});
  if (row.preview_key) await storage.delete(row.preview_key).catch(() => {});
  return true;
}
