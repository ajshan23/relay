import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { localFileStorage, newId } from "@relay/core";
import { writeWorkbook } from "@relay/core/sheets";
import { asc, copyCatalogItems, createCatalogType, createDb, eq, schema } from "@relay/db";
import { fetchPublicFile } from "../src/agent/extract";
import { createCatalogImporter } from "../src/catalog/import";

/*
 * Catalogue imports and copies on the local drill database: a sheet is read with guessed columns, rows
 * with the same id become one item with options, categories are made from paths, bad rows are reported
 * with their row number, importing again updates instead of duplicating, photo links on private
 * addresses are refused, and copying to another branch brings options, categories and gallery along.
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const T = Date.now().toString(36);
const org = `org_i${T}`;
const branch = `br_i${T}`;
const other = `br_i2${T}`;
const dir = mkdtempSync(join(tmpdir(), "relay-import-test-"));
const storage = localFileStorage(dir);
const embedded: string[] = [];
const importer = createCatalogImporter({
  db,
  storage,
  media: null,
  embedSoon: async (_o, b) => {
    embedded.push(b);
  },
});
let typeId = "";

async function importSheet(headers: string[], rows: unknown[][], mapping?: Record<string, string>) {
  const id = newId("catalogImport");
  const storageKey = `imports/${org}/${id}.xlsx`;
  await storage.put(storageKey, writeWorkbook(headers, rows, "xlsx"));
  await db.insert(schema.catalogImport).values({
    id,
    organizationId: org,
    branchId: branch,
    typeId,
    fileName: "items.xlsx",
    storageKey,
  });
  const job = { data: { importId: id, organizationId: org } } as never;
  await importer.read(job);
  const [read] = await db.select().from(schema.catalogImport).where(eq(schema.catalogImport.id, id));
  const sheet = ((read?.sheets ?? []) as { name: string; guesses: Record<string, string> }[])[0];
  await db
    .update(schema.catalogImport)
    .set({ sheet: sheet?.name, mapping: mapping ?? sheet?.guesses, status: "queued" })
    .where(eq(schema.catalogImport.id, id));
  await importer.run(job);
  const [done] = await db.select().from(schema.catalogImport).where(eq(schema.catalogImport.id, id));
  return { read, done };
}

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: org, name: "I test", slug: `i-${T}`, createdAt: new Date() });
  await db.insert(schema.branch).values([
    { id: branch, organizationId: org, name: "Marina", slug: "marina" },
    { id: other, organizationId: org, name: "Downtown", slug: "downtown" },
  ] as never);
  await db.insert(schema.organizationSettings).values({ organizationId: org, catalog: { currency: "AED" } });
  typeId = (
    await createCatalogType(db, {
      organizationId: org,
      name: "Product",
      kind: "product",
      template: "product",
      newId: (k) => newId(k),
    })
  ).id;
});
after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, org));
  await pg.end();
  rmSync(dir, { recursive: true, force: true });
});

const headers = ["Product ID", "Product Name", "Size", "Price", "Stock", "Category", "Brand", "Notes"];

describe("catalogue import", () => {
  it("guesses columns, groups options by id, makes categories, and reports bad rows", async () => {
    const { read, done } = await importSheet(headers, [
      ["TS-1", "Linen shirt", "M", 149, 10, "Men > Shirts", "Lino", "x"],
      ["TS-1", "Linen shirt", "L", 149, 4, "Men > Shirts", "Lino", "x"],
      ["CAP-2", "Cap", "", 39, "", "Accessories", "", ""],
      ["BAD-3", "Broken", "", "free", "", "", "", ""],
      ["", "", "", "", "", "", "", ""],
    ]);
    const guesses = ((read?.sheets ?? []) as { guesses: Record<string, string> }[])[0]?.guesses;
    assert.deepEqual(guesses, {
      "Product ID": "externalId",
      "Product Name": "title",
      Size: "field:size",
      Price: "price",
      Stock: "stock",
      Category: "category",
      Brand: "field:brand",
      Notes: "skip",
    });
    assert.equal(done?.status, "done", done?.readError ?? "");
    assert.equal(done?.created, 2);
    assert.equal(done?.failed, 1);
    // The empty row: the sheet reader drops it before anything is counted.
    assert.deepEqual(
      done?.errors.map((e) => e.row),
      [5],
    );
    assert.match(done?.errors[0]?.reason ?? "", /Price/);
    const [shirt] = await db
      .select()
      .from(schema.catalogItem)
      .where(eq(schema.catalogItem.externalId, "TS-1"));
    const variants = await db
      .select()
      .from(schema.catalogVariant)
      .where(eq(schema.catalogVariant.itemId, shirt?.id ?? ""))
      .orderBy(asc(schema.catalogVariant.position));
    assert.deepEqual(
      variants.map((v) => [v.options.size, v.priceMinor, v.stock]),
      [
        ["M", 14900, 10],
        ["L", 14900, 4],
      ],
    );
    assert.deepEqual(shirt?.attributes, { brand: "Lino" });
    const cats = await db
      .select()
      .from(schema.catalogCategory)
      .where(eq(schema.catalogCategory.branchId, branch));
    assert.deepEqual(cats.map((c) => c.name).sort(), ["Accessories", "Men", "Shirts"]);
    assert.deepEqual(embedded, [branch]);
  });

  it("updates on a second import instead of duplicating", async () => {
    const { done } = await importSheet(headers, [
      ["TS-1", "Linen shirt", "M", 129, 8, "Men > Shirts", "Lino", ""],
      ["TS-1", "Linen shirt", "L", 129, 0, "Men > Shirts", "Lino", ""],
    ]);
    assert.equal(done?.created, 0);
    assert.equal(done?.updated, 1);
    const shirts = await db
      .select()
      .from(schema.catalogItem)
      .where(eq(schema.catalogItem.externalId, "TS-1"));
    assert.equal(shirts.length, 1);
    const variants = await db
      .select()
      .from(schema.catalogVariant)
      .where(eq(schema.catalogVariant.itemId, shirts[0]?.id ?? ""));
    assert.deepEqual(
      variants.map((v) => v.priceMinor),
      [12900, 12900],
    );
    const cats = await db
      .select()
      .from(schema.catalogCategory)
      .where(eq(schema.catalogCategory.branchId, branch));
    assert.equal(cats.length, 3, "no duplicate categories");
  });

  it("refuses photo links on private addresses", async () => {
    await assert.rejects(fetchPublicFile("http://127.0.0.1/photo.jpg", 1000), /public internet/);
    await assert.rejects(fetchPublicFile("http://169.254.169.254/latest/meta-data", 1000), /public internet/);
    await assert.rejects(fetchPublicFile("file:///etc/passwd", 1000), /Only web addresses/);
  });
});

describe("copy to another branch", () => {
  it("copies options, categories and gallery without new files, and clears SKUs already used there", async () => {
    const [shirt] = await db
      .select()
      .from(schema.catalogItem)
      .where(eq(schema.catalogItem.externalId, "TS-1"));
    const fileId = `sf_i${T}`;
    await db
      .insert(schema.storedFile)
      .values({ id: fileId, organizationId: org, sha256: `sha${T}`, sizeBytes: 100, storageKey: "files/x" });
    await db.insert(schema.catalogMedia).values({
      id: newId("catalogMedia"),
      organizationId: org,
      branchId: branch,
      itemId: shirt?.id ?? "",
      fileId,
      kind: "image",
      status: "ready",
      isPrimary: true,
    });
    const vs = await db
      .select()
      .from(schema.catalogVariant)
      .where(eq(schema.catalogVariant.itemId, shirt?.id ?? ""));
    for (const [i, v] of vs.entries())
      await db
        .update(schema.catalogVariant)
        .set({ sku: `SKU-${i}` })
        .where(eq(schema.catalogVariant.id, v.id));
    // A SKU the other branch already has.
    await db.insert(schema.catalogItem).values({
      id: newId("catalogItem"),
      organizationId: org,
      branchId: other,
      typeId,
      title: "Existing",
    });
    const [existing] = await db
      .select()
      .from(schema.catalogItem)
      .where(eq(schema.catalogItem.title, "Existing"));
    await db.insert(schema.catalogVariant).values({
      id: newId("catalogVariant"),
      itemId: existing?.id ?? "",
      organizationId: org,
      branchId: other,
      currency: "AED",
      sku: "SKU-0",
    });
    const copied = await copyCatalogItems(db, {
      organizationId: org,
      fromBranchId: branch,
      toBranchId: other,
      itemIds: [shirt?.id ?? ""],
      userId: null,
      newId: (k) => newId(k),
    });
    assert.deepEqual(copied, { copied: 1, skusCleared: 1 });
    const items = await db.select().from(schema.catalogItem).where(eq(schema.catalogItem.branchId, other));
    const shirtCopy = items.find((i) => i.title === "Linen shirt");
    assert.ok(shirtCopy);
    const variants = await db
      .select()
      .from(schema.catalogVariant)
      .where(eq(schema.catalogVariant.itemId, shirtCopy?.id ?? ""));
    assert.equal(variants.length, 2);
    assert.deepEqual(variants.map((v) => v.sku ?? "").sort(), ["", "SKU-1"]);
    const media = await db
      .select()
      .from(schema.catalogMedia)
      .where(eq(schema.catalogMedia.itemId, shirtCopy?.id ?? ""));
    assert.equal(media[0]?.fileId, fileId, "the same stored file");
    const cats = await db
      .select()
      .from(schema.catalogCategory)
      .where(eq(schema.catalogCategory.branchId, other));
    assert.deepEqual(cats.map((c) => c.name).sort(), ["Men", "Shirts"]);
  });
});
