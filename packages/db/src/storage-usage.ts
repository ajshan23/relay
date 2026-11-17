import { sql } from "drizzle-orm";
import type { createDb } from "./client";
import { storageUsage } from "./schema/settings";

/*
 * File storage per business. Every new stored file adds its size to a running total; uploads by the
 * business are refused when they'd go past the limit, files customers send are always kept (and
 * counted). The total is checked and raised in one UPDATE, so two uploads at once can't both slip
 * past the limit. The nightly sweep recounts it from stored_file.
 */

type Db = ReturnType<typeof createDb>["db"];
/** Something that can run SQL: the db or a transaction. */
type Exec = Pick<Db, "execute">;

/** The limit until plans set their own: 500 MB. */
export const defaultStorageLimitBytes = 500 * 1024 * 1024;
/** Show a warning from this share of the limit. */
export const storageWarnAt = 0.8;

/** "enforce": refuse past the limit (the business's own uploads). "count": always keep, still count. */
export type QuotaMode = "enforce" | "count";

export class StorageFullError extends Error {
  constructor(
    readonly usedBytes: number,
    readonly limitBytes: number,
    readonly neededBytes: number,
  ) {
    super(`Your ${formatBytes(limitBytes)} of storage is full. Delete files you don't need, then try again.`);
    this.name = "StorageFullError";
  }
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Makes sure the business has a row, starting from what it already stores. */
async function ensureRow(db: Exec, organizationId: string) {
  await db.execute(sql`
    insert into ${storageUsage} (organization_id, used_bytes, recounted_at)
    values (${organizationId},
      (select coalesce(sum(size_bytes), 0) from stored_file where organization_id = ${organizationId}),
      now())
    on conflict (organization_id) do nothing`);
}

/** Adds `bytes` to the business's total; with "enforce", throws StorageFullError instead of passing the limit. */
export async function reserveStorage(db: Exec, organizationId: string, bytes: number, mode: QuotaMode) {
  if (bytes <= 0) return;
  await ensureRow(db, organizationId);
  if (mode === "count") {
    await db.execute(
      sql`update ${storageUsage} set used_bytes = used_bytes + ${bytes}, updated_at = now() where organization_id = ${organizationId}`,
    );
    return;
  }
  const res = await db.execute(sql`
    update ${storageUsage}
    set used_bytes = used_bytes + ${bytes}, updated_at = now()
    where organization_id = ${organizationId}
      and used_bytes + ${bytes} <= coalesce(limit_bytes, ${defaultStorageLimitBytes})
    returning used_bytes`);
  if (rowsOf(res).length) return;
  const usage = await getStorageUsage(db, organizationId);
  throw new StorageFullError(usage.usedBytes, usage.limitBytes, bytes);
}

/** Gives back `bytes` (a file deleted, or a reservation that wasn't used). */
export async function releaseStorage(db: Exec, organizationId: string, bytes: number) {
  if (bytes <= 0) return;
  await db.execute(sql`
    update ${storageUsage} set used_bytes = greatest(used_bytes - ${bytes}, 0), updated_at = now()
    where organization_id = ${organizationId}`);
}

/** Used and limit for a business. */
export async function getStorageUsage(db: Exec, organizationId: string) {
  await ensureRow(db, organizationId);
  const res = await db.execute(sql`
    select used_bytes, coalesce(limit_bytes, ${defaultStorageLimitBytes}) as limit_bytes
    from ${storageUsage} where organization_id = ${organizationId}`);
  const row = rowsOf(res)[0] as { used_bytes: string | number; limit_bytes: string | number } | undefined;
  return {
    usedBytes: Number(row?.used_bytes ?? 0),
    limitBytes: Number(row?.limit_bytes ?? defaultStorageLimitBytes),
  };
}

/** Sets every business's total to what stored_file actually holds (nightly, after the sweep). */
export async function recountStorage(db: Exec) {
  await db.execute(sql`
    update ${storageUsage} u
    set used_bytes = coalesce(s.total, 0), recounted_at = now(), updated_at = now()
    from ${storageUsage} u2
    left join (select organization_id, sum(size_bytes) as total from stored_file group by organization_id) s
      on s.organization_id = u2.organization_id
    where u.organization_id = u2.organization_id`);
}

function rowsOf(res: unknown): unknown[] {
  return Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
}
