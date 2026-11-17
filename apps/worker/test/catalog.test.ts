import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { newId } from "@relay/core";
import { CatalogInputError, createCatalogType, createDb, eq, saveCatalogItem, schema } from "@relay/db";

/*
 * The catalogue on the local drill database: types from templates come with their fields, items are
 * checked against their type, prices land in minor units, variants are added, changed and removed in
 * one save, SKUs are unique per branch, and the search text is written.
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const T = Date.now().toString(36);
const org = `org_c${T}`;
const branch = `br_c${T}`;
const other = `br_c2${T}`;
let propertyTypeId = "";

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: org, name: "C test", slug: `c-${T}`, createdAt: new Date() });
  await db.insert(schema.branch).values([
    { id: branch, organizationId: org, name: "Marina", slug: "marina" },
    { id: other, organizationId: org, name: "Downtown", slug: "downtown" },
  ] as never);
});
after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, org));
  await pg.end();
});

const save = (input: Parameters<typeof saveCatalogItem>[1]["input"], itemId?: string, branchId = branch) =>
  saveCatalogItem(db, { organizationId: org, branchId, userId: null, itemId, input, newId: (k) => newId(k) });

describe("catalogue items", () => {
  it("makes a type from a template with its fields", async () => {
    const type = await createCatalogType(db, {
      organizationId: org,
      name: "Property",
      kind: "other",
      template: "property",
      newId: (k) => newId(k),
    });
    propertyTypeId = type.id;
    const fields = await db.select().from(schema.catalogField).where(eq(schema.catalogField.typeId, type.id));
    assert.deepEqual(fields.map((f) => f.key).sort(), [
      "area",
      "bathrooms",
      "bedrooms",
      "furnishing",
      "location",
      "purpose",
    ]);
    assert.ok(fields.find((f) => f.key === "bedrooms")?.filterable);
  });

  it("saves an item with variants, prices in minor units and search words", async () => {
    const item = await save({
      typeId: propertyTypeId,
      title: "2BHK Marina Heights",
      description: "Sea view, close to the metro.",
      attributes: { purpose: "Rent", bedrooms: "2", area: "1,450", furnishing: "Furnished" },
      status: "active",
      tags: ["sea view"],
      variants: [
        {
          title: "Annual",
          price: "95,000",
          currency: "AED",
          sku: "MH-2-A",
          options: {},
          available: true,
          bookable: false,
        },
        {
          title: "Monthly",
          price: 9000,
          currency: "AED",
          sku: "MH-2-M",
          options: {},
          available: true,
          bookable: false,
        },
      ],
    });
    const [row] = await db.select().from(schema.catalogItem).where(eq(schema.catalogItem.id, item.id));
    assert.deepEqual(row?.attributes, { purpose: "rent", bedrooms: 2, area: 1450, furnishing: "furnished" });
    assert.match(row?.searchText ?? "", /Bedrooms: 2\. .*Area: 1,450 sq ft\. .*Options: Annual, Monthly\./);
    const variants = await db
      .select()
      .from(schema.catalogVariant)
      .where(eq(schema.catalogVariant.itemId, item.id));
    assert.deepEqual(variants.map((v) => v.priceMinor).sort(), [900000, 9500000]);

    // Change one option, drop the other, add a new one: one save.
    const annual = variants.find((v) => v.title === "Annual");
    await save(
      {
        typeId: propertyTypeId,
        title: "2BHK Marina Heights",
        description: "",
        attributes: { purpose: "rent" },
        status: "active",
        tags: [],
        variants: [
          {
            id: annual?.id,
            title: "Annual",
            price: 92000,
            currency: "AED",
            sku: "MH-2-A",
            options: {},
            available: true,
            bookable: false,
          },
          {
            title: "Six months",
            price: 50000,
            currency: "AED",
            options: {},
            available: true,
            bookable: false,
          },
        ],
      },
      item.id,
    );
    const after = await db
      .select()
      .from(schema.catalogVariant)
      .where(eq(schema.catalogVariant.itemId, item.id));
    assert.deepEqual(after.map((v) => v.title).sort(), ["Annual", "Six months"]);
    assert.equal(after.find((v) => v.title === "Annual")?.id, annual?.id, "kept its id");
    assert.equal(after.find((v) => v.title === "Annual")?.priceMinor, 9200000);
    const [bumped] = await db.select().from(schema.catalogItem).where(eq(schema.catalogItem.id, item.id));
    assert.equal(bumped?.revision, 2, "searched again after the change");
  });

  it("refuses bad items with a message people can act on", async () => {
    const base = {
      typeId: propertyTypeId,
      title: "Studio",
      description: "",
      status: "active" as const,
      tags: [],
      variants: [{ title: "", price: 40000, currency: "AED", options: {}, available: true, bookable: false }],
    };
    await assert.rejects(save({ ...base, attributes: { bedrooms: 1 } }), /Purpose is required/);
    await assert.rejects(save({ ...base, attributes: { purpose: "lease" } }), CatalogInputError);
    await assert.rejects(
      save({
        ...base,
        attributes: { purpose: "rent" },
        variants: [
          {
            title: "",
            price: 100,
            salePrice: 150,
            currency: "AED",
            options: {},
            available: true,
            bookable: false,
          },
        ],
      }),
      /sale price must be lower/,
    );
    await assert.rejects(
      save({
        ...base,
        attributes: { purpose: "rent" },
        variants: [
          {
            title: "",
            price: 100,
            sku: "MH-2-A",
            currency: "AED",
            options: {},
            available: true,
            bookable: false,
          },
        ],
      }),
      /already uses that SKU/,
    );
  });

  it("keeps branches apart: the same SKU is fine in another branch, and items can't be edited across", async () => {
    const elsewhere = await save(
      {
        typeId: propertyTypeId,
        title: "Copy elsewhere",
        description: "",
        attributes: { purpose: "sale" },
        status: "active",
        tags: [],
        variants: [
          {
            title: "",
            price: 1,
            sku: "MH-2-A",
            currency: "AED",
            options: {},
            available: true,
            bookable: false,
          },
        ],
      },
      undefined,
      other,
    );
    await assert.rejects(
      save(
        {
          typeId: propertyTypeId,
          title: "Hijack",
          description: "",
          attributes: { purpose: "sale" },
          status: "active",
          tags: [],
          variants: [{ title: "", price: 1, currency: "AED", options: {}, available: true, bookable: false }],
        },
        elsewhere.id,
        branch,
      ),
      /isn't in this branch/,
    );
  });
});
