import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { searchTerms } from "@relay/agent";
import { newId } from "@relay/core";
import {
  catalogCards,
  createCatalogType,
  createDb,
  eq,
  priceCatalogOrder,
  saveCatalogItem,
  schema,
  searchCatalog,
} from "@relay/db";
import { createCatalogEmbedder } from "../src/catalog/embed";

/*
 * Catalogue search on the local drill database: exact filters (category with sub-categories, price
 * with the sale price, stock, choice, number range, per-option fields), unknown filters reported back
 * not applied, words and meaning ranked together, other branches never seen, and the embed job only
 * keeping a vector for the text it was made from. The embedder is a fake (words → 512 numbers).
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const T = Date.now().toString(36);
const org = `org_q${T}`;
const branch = `br_q${T}`;
const other = `br_q2${T}`;

function fakeVector(text: string): number[] {
  const v = new Array(512).fill(0);
  for (const w of text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    let h = 0;
    for (const ch of w) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 512;
    v[h] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const embed = async (values: string[]) => ({
  embeddings: values.map(fakeVector),
  tokens: values.join(" ").length / 4,
  model: "text-embedding-3-small",
});
const embedJob = createCatalogEmbedder({ db, embed });
const ids: Record<string, string> = {};
let living = "";
let sofas = "";
let property = "";
let product = "";

const v = (price: number, extra: Record<string, unknown> = {}) => ({
  title: "",
  price,
  currency: "AED",
  options: {},
  available: true,
  bookable: false,
  ...extra,
});

async function add(name: string, input: Record<string, unknown>, branchId = branch) {
  const item = await saveCatalogItem(db, {
    organizationId: org,
    branchId,
    userId: null,
    input: { description: "", status: "active", tags: [], attributes: {}, ...input } as never,
    newId: (k) => newId(k),
  });
  ids[name] = item.id;
}

const find = (terms: string | null, filters = {}, branchId = branch) =>
  searchCatalog(db, {
    organizationId: org,
    branchId,
    terms: terms ? searchTerms(terms) : null,
    embedding: terms ? fakeVector(terms) : null,
    filters,
  });
const names = (found: { ids: string[] }) =>
  found.ids.map((id) => Object.entries(ids).find(([, x]) => x === id)?.[0]).sort();

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: org, name: "Q test", slug: `q-${T}`, createdAt: new Date() });
  await db.insert(schema.branch).values([
    { id: branch, organizationId: org, name: "Marina", slug: "marina" },
    { id: other, organizationId: org, name: "Downtown", slug: "downtown" },
  ] as never);
  property = (
    await createCatalogType(db, {
      organizationId: org,
      name: "Property",
      kind: "other",
      template: "property",
      newId: (k) => newId(k),
    })
  ).id;
  const p = await createCatalogType(db, {
    organizationId: org,
    name: "Furniture",
    kind: "product",
    template: "product",
    newId: (k) => newId(k),
  });
  product = p.id;
  // Make colour (a per-option field) filterable.
  await db
    .update(schema.catalogField)
    .set({
      filterable: true,
      type: "select",
      options: [
        { value: "grey", label: "Grey" },
        { value: "blue", label: "Blue" },
      ],
    })
    .where(eq(schema.catalogField.key, "colour"));
  const [l] = await db
    .insert(schema.catalogCategory)
    .values({ id: newId("catalogCategory"), organizationId: org, branchId: branch, name: "Living" })
    .returning();
  living = l?.id ?? "";
  const [s] = await db
    .insert(schema.catalogCategory)
    .values({
      id: newId("catalogCategory"),
      organizationId: org,
      branchId: branch,
      name: "Sofas",
      parentId: living,
    })
    .returning();
  sofas = s?.id ?? "";

  await add("studio", {
    typeId: property,
    title: "Studio Marina Walk",
    attributes: { purpose: "rent", bedrooms: 0, area: 450 },
    variants: [v(45000)],
  });
  await add("twobed", {
    typeId: property,
    title: "2BHK Marina Heights sea view",
    attributes: { purpose: "rent", bedrooms: 2, area: 1450 },
    variants: [v(95000)],
  });
  await add("villa", {
    typeId: property,
    title: "4 bedroom villa",
    attributes: { purpose: "sale", bedrooms: 4, area: 4200 },
    variants: [v(4200000)],
  });
  await add("sofa", {
    typeId: product,
    categoryId: sofas,
    title: "Sofa Oslo",
    description: "Soft three seater couch",
    variants: [
      v(2500, { title: "Grey", options: { colour: "grey" }, salePrice: 1800 }),
      v(2500, { title: "Blue", options: { colour: "blue" }, stock: 0 }),
    ],
  });
  await add("table", {
    typeId: product,
    categoryId: living,
    title: "Oak coffee table",
    variants: [v(900, { stock: 3 })],
  });
  await add("elsewhere", { typeId: product, title: "Sofa Oslo (Downtown)", variants: [v(10)] }, other);
  await embedJob({ data: { organizationId: org, branchId: branch } } as never);
  await embedJob({ data: { organizationId: org, branchId: other } } as never);
});
after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, org));
  await pg.end();
});

describe("catalogue search", () => {
  it("filters exactly on choices and number ranges", async () => {
    assert.deepEqual(names(await find(null, { fields: { purpose: "Rent" } })), ["studio", "twobed"]);
    assert.deepEqual(names(await find(null, { fields: { bedrooms: { min: 2 } } })), ["twobed", "villa"]);
    assert.deepEqual(names(await find(null, { fields: { purpose: "rent", bedrooms: 2 } })), ["twobed"]);
  });

  it("filters price on the sale price, and stock and colour on the same option", async () => {
    assert.deepEqual(
      names(await find(null, { priceMax: 2000 })),
      ["sofa", "table"],
      "the grey sofa is on sale at 1,800",
    );
    assert.deepEqual(names(await find(null, { priceMax: 2000, fields: { colour: "Blue" } })), []);
    assert.deepEqual(names(await find(null, { fields: { colour: "blue" } })), ["sofa"]);
    assert.deepEqual(
      names(await find(null, { fields: { colour: "blue" }, inStock: true })),
      [],
      "blue is sold out",
    );
    assert.deepEqual(names(await find(null, { priceMin: 50000, priceMax: 100000, currency: "AED" })), [
      "twobed",
    ]);
  });

  it("includes sub-categories, and reports filters it couldn't use instead of guessing", async () => {
    assert.deepEqual(names(await find(null, { categoryId: living })), ["sofa", "table"]);
    assert.deepEqual(names(await find(null, { categoryId: sofas })), ["sofa"]);
    const r = await find(null, { fields: { pool: true, "x') or 1=1 --": 1, purpose: "lease" } });
    assert.deepEqual(r.ignoredFilters.sort(), ["purpose", "pool", "x') or 1=1 --"].sort());
  });

  it("ranks by words and meaning, and never shows another branch", async () => {
    const r = await find("couch for the living room");
    assert.equal(
      names({ ids: r.ids.slice(0, 1) })[0],
      "sofa",
      "found by meaning: 'couch' is in its description",
    );
    const sea = await find("sea view");
    assert.equal(names({ ids: sea.ids.slice(0, 1) })[0], "twobed");
    assert.ok(!(await find("Sofa Oslo")).ids.includes(ids.elsewhere ?? ""));
    assert.deepEqual(names(await find("Sofa Oslo", {}, other)), ["elsewhere"]);
  });

  it("prices an order exactly, and asks for the option instead of guessing", async () => {
    const o = { organizationId: org, branchId: branch };
    const ok = await priceCatalogOrder(db, {
      ...o,
      lines: [
        { itemId: ids.sofa ?? "", option: "grey", quantity: 2 },
        { itemId: ids.table ?? "", quantity: 1 },
      ],
    });
    assert.equal(ok.total, "AED 4,500", "2 × 1,800 (sale) + 900");
    const unclear = await priceCatalogOrder(db, { ...o, lines: [{ itemId: ids.sofa ?? "", quantity: 1 }] });
    assert.equal(unclear.total, null);
    assert.match(JSON.stringify(unclear.lines[0]), /Which option/);
    const short = await priceCatalogOrder(db, { ...o, lines: [{ itemId: ids.table ?? "", quantity: 5 }] });
    assert.match(JSON.stringify(short.lines[0]), /Only 3 in stock/);
  });

  it("gives cards with facts and prices, and the embed job keeps up with edits", async () => {
    const [card] = await catalogCards(db, { organizationId: org, branchId: branch, ids: [ids.sofa ?? ""] });
    assert.equal(card?.priceText, "AED 1,800 – 2,500");
    assert.deepEqual(
      card?.variants.map((x) => [x.title, x.salePrice?.text ?? x.price?.text, x.available, x.details]),
      [
        ["Grey", "AED 1,800", true, ["Colour: Grey"]],
        ["Blue", "AED 2,500", false, ["Colour: Blue"]],
      ],
    );
    assert.equal(
      (await catalogCards(db, { organizationId: org, branchId: other, ids: [ids.sofa ?? ""] })).length,
      0,
    );

    const [row] = await db
      .select()
      .from(schema.catalogItem)
      .where(eq(schema.catalogItem.id, ids.table ?? ""));
    assert.equal(row?.embeddedRevision, row?.revision, "embedded");
    await db
      .update(schema.catalogItem)
      .set({ revision: (row?.revision ?? 1) + 1, title: "Walnut coffee table" })
      .where(eq(schema.catalogItem.id, ids.table ?? ""));
    await embedJob({ data: { organizationId: org, branchId: branch } } as never);
    const [again] = await db
      .select()
      .from(schema.catalogItem)
      .where(eq(schema.catalogItem.id, ids.table ?? ""));
    assert.equal(again?.embeddedRevision, again?.revision, "the edit was embedded");
  });
});
