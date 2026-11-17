import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  createDb,
  defaultStorageLimitBytes,
  eq,
  getStorageUsage,
  StorageFullError,
  schema,
  sql,
  storeFile,
} from "@relay/db";
import { createFileSweep } from "../src/files/sweep";

/*
 * Storage per business on the local drill database: new files count once, re-used files don't, the
 * business's own uploads stop at the limit (even two at once), customers' files are always kept, and
 * the nightly sweep keeps files that knowledge or an agent still use while freeing the rest.
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const T = Date.now().toString(36);
const org = `org_s${T}`;
let n = 0;
const newId = () => `sf_${T}_${++n}`;
const objects = new Map<string, Uint8Array>();
const storage = {
  put: async (key: string, bytes: Uint8Array) => {
    objects.set(key, bytes);
  },
  delete: async (key: string) => {
    objects.delete(key);
  },
};
const bytes = (size: number, fill: number) => new Uint8Array(size).fill(fill);
const used = async () => (await getStorageUsage(db, org)).usedBytes;

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: org, name: "S test", slug: `s-${T}`, createdAt: new Date() });
});
after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, org));
  await pg.end();
});

describe("storage per business", () => {
  it("counts a new file once and a re-used file not at all", async () => {
    const before = await used();
    await storeFile(db, storage, { organizationId: org, bytes: bytes(1000, 1), newId, quota: "enforce" });
    await storeFile(db, storage, { organizationId: org, bytes: bytes(1000, 1), newId, quota: "enforce" });
    assert.equal((await used()) - before, 1000);
    assert.equal((await getStorageUsage(db, org)).limitBytes, defaultStorageLimitBytes);
  });

  it("refuses the business's upload past the limit, but always keeps a customer's file", async () => {
    await db
      .update(schema.storageUsage)
      .set({ limitBytes: 5000 })
      .where(eq(schema.storageUsage.organizationId, org));
    const start = await used();
    await assert.rejects(
      storeFile(db, storage, { organizationId: org, bytes: bytes(5000, 2), newId, quota: "enforce" }),
      (err) => err instanceof StorageFullError && /storage is full/.test(err.message),
    );
    assert.equal(await used(), start, "nothing reserved for a refused upload");
    await storeFile(db, storage, { organizationId: org, bytes: bytes(5000, 3), newId, quota: "count" });
    assert.equal(await used(), start + 5000, "the customer's file counts");
  });

  it("lets only one of two uploads at once through when only one fits", async () => {
    await db
      .update(schema.storageUsage)
      .set({ limitBytes: (await used()) + 1500 })
      .where(eq(schema.storageUsage.organizationId, org));
    const results = await Promise.allSettled([
      storeFile(db, storage, { organizationId: org, bytes: bytes(1000, 4), newId, quota: "enforce" }),
      storeFile(db, storage, { organizationId: org, bytes: bytes(1000, 5), newId, quota: "enforce" }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  });

  it("the sweep keeps files knowledge and agents use, deletes the rest, and recounts", async () => {
    await db
      .update(schema.storageUsage)
      .set({ limitBytes: null })
      .where(eq(schema.storageUsage.organizationId, org));
    const keep = await storeFile(db, storage, {
      organizationId: org,
      bytes: bytes(700, 6),
      newId,
      quota: "enforce",
    });
    const avatar = await storeFile(db, storage, {
      organizationId: org,
      bytes: bytes(600, 7),
      newId,
      quota: "enforce",
    });
    const gone = await storeFile(db, storage, {
      organizationId: org,
      bytes: bytes(500, 8),
      newId,
      quota: "enforce",
    });
    const branch = `br_s${T}`;
    await db
      .insert(schema.branch)
      .values({ id: branch, organizationId: org, name: "Kochi", slug: "kochi" } as never);
    await db.insert(schema.knowledgeSource).values({
      id: `ks_s${T}`,
      organizationId: org,
      branchId: branch,
      kind: "file",
      title: "Price list",
      fileId: keep.file.id,
      fileName: "prices.pdf",
    } as never);
    await db.insert(schema.aiAgent).values({
      id: `agt_s${T}`,
      organizationId: org,
      branchId: branch,
      name: "Mira",
      avatarFileId: avatar.file.id,
      handoff: { when: "", assignToUserId: null, message: "" },
    } as never);
    // Everything here is "old" and only the knowledge file and the avatar are pointed at.
    await db.execute(
      sql`update stored_file set last_used_at = now() - interval '8 days' where organization_id = ${org}`,
    );
    // Drift the counter, so the recount has something to fix.
    await db
      .update(schema.storageUsage)
      .set({ usedBytes: 1 })
      .where(eq(schema.storageUsage.organizationId, org));
    await createFileSweep({ db, storage: storage as never })();
    const left = await db
      .select({ id: schema.storedFile.id, size: schema.storedFile.sizeBytes })
      .from(schema.storedFile)
      .where(eq(schema.storedFile.organizationId, org));
    const ids = left.map((r) => r.id);
    assert.ok(ids.includes(keep.file.id), "knowledge file kept");
    assert.ok(ids.includes(avatar.file.id), "avatar kept");
    assert.ok(!ids.includes(gone.file.id), "unused file deleted");
    assert.ok(!objects.has(gone.file.storageKey), "its object deleted");
    assert.equal(
      await used(),
      left.reduce((s, r) => s + r.size, 0),
      "recounted from what is stored",
    );
  });
});
