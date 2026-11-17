import { z } from "zod";
import { coerceFieldValue, type FieldType, fieldKey } from "./contacts";

/*
 * The catalogue's shared rules: starting templates for item types, what the API accepts, money in
 * minor units, and the words an item is searched by. Used by the API, the worker and the web app.
 */

export type CatalogTypeKind = "product" | "service" | "other";

export type CatalogFieldInput = {
  label: string;
  type: FieldType;
  options?: string[];
  unit?: string;
  onVariant?: boolean;
  filterable?: boolean;
  required?: boolean;
};

export type CatalogTemplate = {
  id: string;
  name: string;
  kind: CatalogTypeKind;
  /** What it suits, shown when picking a template. */
  hint: string;
  fields: CatalogFieldInput[];
};

/** Field types a customer can filter on. */
export const filterableFieldTypes: FieldType[] = ["number", "boolean", "select", "multi_select", "date"];

export const catalogTemplates: CatalogTemplate[] = [
  {
    id: "product",
    name: "Product",
    kind: "product",
    hint: "Things you sell: clothes, furniture, electronics, beauty, groceries.",
    fields: [
      { label: "Brand", type: "text" },
      { label: "Colour", type: "text", onVariant: true },
      { label: "Size", type: "text", onVariant: true },
      { label: "Material", type: "text" },
    ],
  },
  {
    id: "service",
    name: "Service",
    kind: "service",
    hint: "Treatments, appointments and sessions: clinics, salons, consultants. Each option has a length.",
    fields: [{ label: "Good for", type: "text" }],
  },
  {
    id: "menu_item",
    name: "Menu item",
    kind: "product",
    hint: "Dishes and drinks, with sizes as options.",
    fields: [
      { label: "Vegetarian", type: "boolean", filterable: true },
      { label: "Spice level", type: "select", options: ["Mild", "Medium", "Hot"], filterable: true },
      { label: "Serves", type: "number", filterable: true },
      { label: "Allergens", type: "text" },
    ],
  },
  {
    id: "property",
    name: "Property",
    kind: "other",
    hint: "Homes and spaces to rent or buy.",
    fields: [
      { label: "Purpose", type: "select", options: ["Rent", "Sale"], filterable: true, required: true },
      { label: "Bedrooms", type: "number", filterable: true },
      { label: "Bathrooms", type: "number", filterable: true },
      { label: "Area", type: "number", unit: "sq ft", filterable: true },
      {
        label: "Furnishing",
        type: "select",
        options: ["Furnished", "Semi-furnished", "Unfurnished"],
        filterable: true,
      },
      { label: "Location", type: "text" },
    ],
  },
  {
    id: "room",
    name: "Room",
    kind: "service",
    hint: "Hotel rooms, stays and venues, priced per night or per booking.",
    fields: [
      { label: "Guests", type: "number", filterable: true },
      { label: "Beds", type: "text" },
      { label: "Breakfast included", type: "boolean", filterable: true },
      { label: "View", type: "text" },
    ],
  },
  {
    id: "course",
    name: "Course",
    kind: "service",
    hint: "Classes, courses and programmes.",
    fields: [
      { label: "Mode", type: "select", options: ["Online", "In person"], filterable: true },
      { label: "Level", type: "select", options: ["Beginner", "Intermediate", "Advanced"], filterable: true },
      { label: "Length", type: "number", unit: "weeks", filterable: true },
      { label: "Starts on", type: "date", filterable: true },
    ],
  },
  {
    id: "vehicle",
    name: "Vehicle",
    kind: "product",
    hint: "Cars, bikes and other vehicles for sale or rent.",
    fields: [
      { label: "Make", type: "text" },
      { label: "Model", type: "text" },
      { label: "Year", type: "number", filterable: true },
      { label: "Kilometres", type: "number", unit: "km", filterable: true },
      {
        label: "Fuel",
        type: "select",
        options: ["Petrol", "Diesel", "Hybrid", "Electric"],
        filterable: true,
      },
      { label: "Transmission", type: "select", options: ["Automatic", "Manual"], filterable: true },
    ],
  },
  {
    id: "package",
    name: "Package",
    kind: "other",
    hint: "Bundles, memberships and offers.",
    fields: [
      { label: "Includes", type: "text" },
      { label: "Valid for", type: "number", unit: "days" },
    ],
  },
];

/** Options as stored: value is a stable key made from the label. */
export function optionsFromLabels(labels: string[]) {
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const raw of labels) {
    const label = raw.trim().slice(0, 60);
    if (!label) continue;
    let value = fieldKey(label);
    for (let n = 2; seen.has(value); n++) value = `${fieldKey(label)}_${n}`;
    seen.add(value);
    out.push({ value, label });
  }
  return out;
}

/* ------------------------------------------------------------------ money */

/** How many decimals a currency uses (AED 2, JPY 0, KWD 3). */
export function currencyDigits(currency: string) {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ??
      2
    );
  } catch {
    return 2;
  }
}

/** 1200.5 AED → 120050. Throws on a bad amount. */
export function toMinor(amount: number | string, currency: string) {
  const n = typeof amount === "number" ? amount : Number(String(amount).replace(/[, ]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new Error("expected a price of 0 or more");
  return Math.round(n * 10 ** currencyDigits(currency));
}

export function fromMinor(minor: number, currency: string) {
  return minor / 10 ** currencyDigits(currency);
}

/** 120000 AED → "AED 1,200"; 120050 → "AED 1,200.50". */
export function formatMoney(minor: number, currency: string) {
  const amount = fromMinor(minor, currency);
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      currencyDisplay: "code",
      minimumFractionDigits: whole ? 0 : undefined,
      maximumFractionDigits: whole ? 0 : undefined,
    })
      .format(amount)
      .replace(/ /g, " ");
  } catch {
    return `${currency} ${amount}`;
  }
}

export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Use a 3-letter currency code, like AED or INR.");

/* ------------------------------------------------------------------ API input */

export const catalogFieldSchema = z
  .object({
    label: z.string().trim().min(1, "Give the field a name").max(60),
    type: z.enum(["text", "number", "date", "boolean", "select", "multi_select", "email", "phone", "url"]),
    options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    unit: z.string().trim().max(20).optional(),
    onVariant: z.boolean().default(false),
    filterable: z.boolean().default(false),
    required: z.boolean().default(false),
  })
  .refine((f) => !["select", "multi_select"].includes(f.type) || f.options.length > 0, {
    message: "Add at least one choice.",
    path: ["options"],
  })
  .refine((f) => !f.filterable || filterableFieldTypes.includes(f.type), {
    message: "Only choice, yes/no, number and date fields can be filters.",
    path: ["filterable"],
  });

export const catalogTypeSchema = z.object({
  name: z.string().trim().min(1, "Give the type a name").max(60),
  kind: z.enum(["product", "service", "other"]).default("product"),
  /** Start from a template's fields. */
  template: z.string().optional(),
});

export const catalogVariantSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().max(80).default(""),
  sku: z.string().trim().max(64).nullable().optional(),
  /** In normal units (1200.50); null = price on request. */
  price: z.union([z.number(), z.string()]).nullable().optional(),
  salePrice: z.union([z.number(), z.string()]).nullable().optional(),
  currency: currencySchema,
  options: z.record(z.string(), z.unknown()).default({}),
  stock: z.number().int().min(0).max(10_000_000).nullable().optional(),
  available: z.boolean().default(true),
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30)
    .nullable()
    .optional(),
  bookable: z.boolean().default(false),
});

export const catalogItemSchema = z.object({
  typeId: z.string().min(1),
  categoryId: z.string().nullable().optional(),
  title: z.string().trim().min(1, "Give it a name").max(200),
  description: z.string().trim().max(5000).default(""),
  attributes: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["active", "draft", "archived"]).default("active"),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  variants: z.array(catalogVariantSchema).min(1, "Add a price").max(100),
});

export type CatalogItemInput = z.infer<typeof catalogItemSchema>;

/** A field definition as the rules below need it. */
export type CatalogFieldDef = {
  key: string;
  label: string;
  type: FieldType;
  options: { value: string; label: string; colour?: string }[];
  unit?: string | null;
  onVariant: boolean;
  filterable: boolean;
  required: boolean;
};

/**
 * Checks field values against the type's fields: unknown keys and bad values are errors, required
 * ones must be there. Returns the clean values in their stored types.
 */
export function cleanCatalogValues(
  fields: CatalogFieldDef[],
  input: Record<string, unknown>,
  scope: "item" | "variant",
): { ok: true; values: Record<string, unknown> } | { ok: false; message: string } {
  const mine = fields.filter((f) => f.onVariant === (scope === "variant"));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const field = mine.find((f) => f.key === key);
    if (!field) return { ok: false, message: `There's no field "${key}" here.` };
    const res = coerceFieldValue(
      { ...field, options: field.options.map((o) => ({ ...o, colour: o.colour ?? "gray" })) },
      raw,
    );
    if (!res.ok) return res;
    if (res.value !== null && !(Array.isArray(res.value) && !res.value.length)) out[key] = res.value;
  }
  for (const f of mine)
    if (f.required && out[f.key] === undefined) return { ok: false, message: `${f.label} is required.` };
  return { ok: true, values: out };
}

/** A field value as words: "Rent", "Yes", "1,450 sq ft", "Mild, Hot". */
export function fieldValueText(field: CatalogFieldDef, value: unknown): string {
  if (value === null || value === undefined) return "";
  const label = (v: unknown) => field.options.find((o) => o.value === v)?.label ?? String(v);
  if (field.type === "boolean") return value ? "Yes" : "No";
  if (field.type === "select") return label(value);
  if (field.type === "multi_select") return (Array.isArray(value) ? value : [value]).map(label).join(", ");
  if (field.type === "number")
    return `${Number(value).toLocaleString("en")}${field.unit ? ` ${field.unit}` : ""}`;
  return String(value);
}

/**
 * The words an item is found by, besides its title and description: type, category path and every
 * field value ("Type: Property. Category: Apartments. Bedrooms: 2. Furnishing: Furnished.").
 */
export function catalogSearchText(input: {
  typeName: string;
  categoryPath: string[];
  fields: CatalogFieldDef[];
  attributes: Record<string, unknown>;
  variants: { title: string; options: Record<string, unknown> }[];
  tags: string[];
}) {
  const parts = [`Type: ${input.typeName}.`];
  if (input.categoryPath.length) parts.push(`Category: ${input.categoryPath.join(" › ")}.`);
  for (const f of input.fields) {
    if (f.onVariant) {
      const values = [
        ...new Set(input.variants.map((v) => fieldValueText(f, v.options[f.key])).filter(Boolean)),
      ];
      if (values.length) parts.push(`${f.label}: ${values.join(", ")}.`);
    } else {
      const text = fieldValueText(f, input.attributes[f.key]);
      if (text) parts.push(`${f.label}: ${text}.`);
    }
  }
  const options = input.variants.map((v) => v.title).filter(Boolean);
  if (options.length) parts.push(`Options: ${options.join(", ")}.`);
  if (input.tags.length) parts.push(`Tags: ${input.tags.join(", ")}.`);
  return parts.join(" ");
}

/** Media limits per file, inside the business's storage. */
export const catalogMediaLimits = {
  filesPerItem: 20,
  /** What can be uploaded before it's prepared for WhatsApp (videos are converted down). */
  uploadMaxBytes: {
    image: 25 * 1024 ** 2,
    video: 200 * 1024 ** 2,
    audio: 50 * 1024 ** 2,
    document: 100 * 1024 ** 2,
  },
  /** What WhatsApp accepts, which the prepared file must fit. */
  sendMaxBytes: {
    image: 5 * 1024 ** 2,
    video: 16 * 1024 ** 2,
    audio: 16 * 1024 ** 2,
    document: 100 * 1024 ** 2,
  },
} as const;

export type CatalogMediaKind = keyof typeof catalogMediaLimits.sendMaxBytes;

/** Which gallery kind a file is, from its type, or null when it can't be used. */
export function catalogMediaKind(mimeType: string): CatalogMediaKind | null {
  const m = mimeType.toLowerCase();
  if (/^image\/(jpeg|png|webp|heic|heif|gif)$/.test(m)) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "document";
  return null;
}

/* ------------------------------------------------------------------ imports */

/**
 * Where a spreadsheet column goes. Rows with the same id (or, without an id column, the same name)
 * become one item, each row one of its options.
 */
export type CatalogImportTarget =
  | "skip"
  | "title"
  | "description"
  | "category"
  | "price"
  | "salePrice"
  | "currency"
  | "sku"
  | "stock"
  | "duration"
  | "option"
  | "externalId"
  | "images"
  | "tags"
  | "status"
  | `field:${string}`;

export const catalogImportTargets: { value: CatalogImportTarget; label: string; hint: string }[] = [
  { value: "title", label: "Name", hint: "Required" },
  { value: "description", label: "Description", hint: "" },
  { value: "category", label: "Category", hint: 'Use "Living > Sofas" for one inside another' },
  { value: "price", label: "Price", hint: "" },
  { value: "salePrice", label: "Sale price", hint: "" },
  { value: "currency", label: "Currency", hint: "Otherwise your catalogue's currency" },
  { value: "sku", label: "SKU", hint: "" },
  { value: "stock", label: "Stock", hint: "" },
  { value: "duration", label: "Length (minutes)", hint: "Services" },
  { value: "option", label: "Option name", hint: "Rows with the same name or id become options" },
  { value: "externalId", label: "Your id", hint: "Importing again updates these items" },
  { value: "images", label: "Photo links", hint: "Web addresses, separated by commas" },
  { value: "tags", label: "Tags", hint: "Separated by commas" },
  { value: "status", label: "Status", hint: "On sale, draft or archived" },
  { value: "skip", label: "Don't import", hint: "" },
];

const guesses: [RegExp, CatalogImportTarget][] = [
  [/^(name|title|product|product name|item|item name|service)$/i, "title"],
  [/desc/i, "description"],
  [/categor|collection|department/i, "category"],
  [/^(sale|offer|discount)\s*price|compare/i, "salePrice"],
  [/price|mrp|rate|cost|amount/i, "price"],
  [/^currency$/i, "currency"],
  [/sku|barcode|code$/i, "sku"],
  [/stock|qty|quantity|inventory/i, "stock"],
  [/duration|length|minutes|mins/i, "duration"],
  [/^(variant|option|size|variation)( name)?$/i, "option"],
  [/^(id|external id|product id|handle)$/i, "externalId"],
  [/image|photo|picture|img/i, "images"],
  [/^tags?$/i, "tags"],
  [/^status$/i, "status"],
];

/** A first guess for a column: one of the type's fields by name, else a known column, else skip. */
export function guessCatalogTarget(
  header: string,
  fields: Pick<CatalogFieldDef, "key" | "label">[],
): CatalogImportTarget {
  const h = header.trim();
  const field = fields.find((f) => f.label.toLowerCase() === h.toLowerCase() || f.key === fieldKey(h));
  if (field) return `field:${field.key}`;
  for (const [re, target] of guesses) if (re.test(h)) return target;
  return "skip";
}

export type CatalogImportSheet = {
  name: string;
  headers: string[];
  rowCount: number;
  preview: unknown[][];
  guesses: Record<string, CatalogImportTarget>;
};

export function summarizeCatalogSheet(
  sheet: { name: string; headers: string[]; rows: unknown[][] },
  fields: Pick<CatalogFieldDef, "key" | "label">[],
): CatalogImportSheet {
  const used = new Set<CatalogImportTarget>();
  const guessed: Record<string, CatalogImportTarget> = {};
  for (const h of sheet.headers) {
    let g = guessCatalogTarget(h, fields);
    // One column per target, except skip.
    if (g !== "skip" && used.has(g)) g = "skip";
    used.add(g);
    guessed[h] = g;
  }
  return {
    name: sheet.name,
    headers: sheet.headers,
    rowCount: sheet.rows.length,
    preview: sheet.rows.slice(0, 5),
    guesses: guessed,
  };
}
