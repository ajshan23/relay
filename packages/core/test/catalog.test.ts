import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CatalogFieldDef,
  catalogFieldSchema,
  catalogMediaKind,
  catalogSearchText,
  cleanCatalogValues,
  currencyDigits,
  formatMoney,
  fromMinor,
  optionsFromLabels,
  toMinor,
} from "../src/catalog";

const fields: CatalogFieldDef[] = [
  {
    key: "purpose",
    label: "Purpose",
    type: "select",
    options: optionsFromLabels(["Rent", "Sale"]),
    onVariant: false,
    filterable: true,
    required: true,
  },
  {
    key: "bedrooms",
    label: "Bedrooms",
    type: "number",
    options: [],
    onVariant: false,
    filterable: true,
    required: false,
  },
  {
    key: "area",
    label: "Area",
    type: "number",
    options: [],
    unit: "sq ft",
    onVariant: false,
    filterable: true,
    required: false,
  },
  {
    key: "colour",
    label: "Colour",
    type: "text",
    options: [],
    onVariant: true,
    filterable: false,
    required: false,
  },
];

describe("catalogue money", () => {
  it("uses each currency's decimals", () => {
    assert.equal(currencyDigits("AED"), 2);
    assert.equal(currencyDigits("JPY"), 0);
    assert.equal(currencyDigits("KWD"), 3);
    assert.equal(toMinor("1,200.50", "AED"), 120050);
    assert.equal(toMinor(1.234, "KWD"), 1234);
    assert.equal(fromMinor(120050, "AED"), 1200.5);
    assert.throws(() => toMinor(-1, "AED"));
    assert.throws(() => toMinor("abc", "AED"));
  });

  it("formats whole amounts without decimals", () => {
    assert.equal(formatMoney(120000, "AED"), "AED 1,200");
    assert.equal(formatMoney(120050, "AED"), "AED 1,200.50");
    assert.equal(formatMoney(499900, "INR"), "INR 4,999");
  });
});

describe("catalogue fields", () => {
  it("checks values against the type and keeps them in their real types", () => {
    const ok = cleanCatalogValues(fields, { purpose: "rent", bedrooms: "2", area: "1,450" }, "item");
    assert.deepEqual(ok, { ok: true, values: { purpose: "rent", bedrooms: 2, area: 1450 } });
    assert.deepEqual(cleanCatalogValues(fields, { purpose: "Sale" }, "item"), {
      ok: true,
      values: { purpose: "sale" },
    });
  });

  it("refuses unknown fields, bad values, missing required ones, and variant fields on the item", () => {
    assert.equal(cleanCatalogValues(fields, { purpose: "rent", pool: true }, "item").ok, false);
    assert.equal(cleanCatalogValues(fields, { purpose: "lease" }, "item").ok, false);
    assert.equal(cleanCatalogValues(fields, { bedrooms: 2 }, "item").ok, false, "purpose is required");
    assert.equal(cleanCatalogValues(fields, { purpose: "rent", colour: "Grey" }, "item").ok, false);
    assert.deepEqual(cleanCatalogValues(fields, { colour: "Grey" }, "variant"), {
      ok: true,
      values: { colour: "Grey" },
    });
  });

  it("only lets choice, yes/no, number and date fields be filters", () => {
    assert.equal(
      catalogFieldSchema.safeParse({ label: "Notes", type: "text", filterable: true }).success,
      false,
    );
    assert.equal(
      catalogFieldSchema.safeParse({ label: "Beds", type: "number", filterable: true }).success,
      true,
    );
    assert.equal(
      catalogFieldSchema.safeParse({ label: "Fuel", type: "select" }).success,
      false,
      "needs choices",
    );
  });

  it("makes stable keys for choices, even with repeats", () => {
    assert.deepEqual(optionsFromLabels(["Semi-furnished", "Semi furnished", " "]), [
      { value: "semi_furnished", label: "Semi-furnished" },
      { value: "semi_furnished_2", label: "Semi furnished" },
    ]);
  });
});

describe("catalogue search text", () => {
  it("writes type, category, field values, options and tags in words", () => {
    const text = catalogSearchText({
      typeName: "Property",
      categoryPath: ["Apartments", "Marina"],
      fields,
      attributes: { purpose: "rent", bedrooms: 2, area: 1450 },
      variants: [
        { title: "Annual", options: { colour: "White" } },
        { title: "Monthly", options: { colour: "White" } },
      ],
      tags: ["sea view"],
    });
    assert.equal(
      text,
      "Type: Property. Category: Apartments › Marina. Purpose: Rent. Bedrooms: 2. Area: 1,450 sq ft. Colour: White. Options: Annual, Monthly. Tags: sea view.",
    );
  });

  it("knows which files a gallery takes", () => {
    assert.equal(catalogMediaKind("image/jpeg"), "image");
    assert.equal(catalogMediaKind("video/quicktime"), "video");
    assert.equal(catalogMediaKind("audio/mpeg"), "audio");
    assert.equal(catalogMediaKind("application/pdf"), "document");
    assert.equal(catalogMediaKind("application/zip"), null);
  });
});
