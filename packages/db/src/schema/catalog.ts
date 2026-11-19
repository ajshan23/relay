import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  halfvec,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { branch } from "./branches";
import { fieldType, importStatus } from "./contacts";
import { storedFile } from "./messaging";

/*
 * The catalogue: anything a business sells (products, services, menu dishes, properties, rooms,
 * courses, vehicles, packages), one catalogue per branch.
 *
 *   type     what kind of thing it is and which fields it has (business-wide, e.g. "Property":
 *            bedrooms, area, furnished). Values live in item.attributes / variant.options by key.
 *   item     the thing itself: title, description, category, field values, gallery. No price.
 *   variant  the sellable unit with the price (amount in minor units + currency), stock, and for
 *            services the duration. Every item has at least one.
 *   media    the item's ordered gallery (images, videos, audio, documents), one of them primary.
 *
 * Search: a generated full-text column plus a small embedding (512 dims, halfvec). There is
 * deliberately no vector index: every search first narrows to one business's branch with btree
 * indexes, then measures distance exactly on those rows (full recall, no cross-business filtering).
 */

export const catalogTypeKind = pgEnum("catalog_type_kind", ["product", "service", "other"]);
export const catalogItemStatus = pgEnum("catalog_item_status", ["active", "draft", "archived"]);
export const catalogMediaKind = pgEnum("catalog_media_kind", ["image", "video", "audio", "document"]);
export const catalogMediaStatus = pgEnum("catalog_media_status", ["processing", "ready", "failed"]);

export type CatalogFieldOption = { value: string; label: string; colour?: string };

/** A kind of thing the business sells, with its fields. Shared by all branches. */
export const catalogType = pgTable(
  "catalog_type",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: catalogTypeKind("kind").notNull().default("product"),
    /** The starting template it was made from ("property"), or null for blank. */
    template: text("template"),
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("catalog_type_org_idx").on(t.organizationId, t.position)],
);

/** One field of a type. Key and data type never change once made, like contact fields. */
export const catalogField = pgTable(
  "catalog_field",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    typeId: text("type_id")
      .notNull()
      .references(() => catalogType.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: fieldType("type").notNull(),
    options: jsonb("options").$type<CatalogFieldOption[]>().notNull().default([]),
    /** Shown after the value: "sq ft", "km", "min". */
    unit: text("unit"),
    /** The value differs per variant (size, colour) rather than per item. */
    onVariant: boolean("on_variant").notNull().default(false),
    /** Customers (and Mira) can filter on it: choice, yes/no and number fields. */
    filterable: boolean("filterable").notNull().default(false),
    required: boolean("required").notNull().default(false),
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("catalog_field_key_uidx").on(t.typeId, t.key)],
);

/** A branch's categories, as a tree ("Hair › Colour"). */
export const catalogCategory = pgTable(
  "catalog_category",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    // biome-ignore lint/suspicious/noExplicitAny: self reference
    parentId: text("parent_id").references((): any => catalogCategory.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("catalog_category_branch_idx").on(t.organizationId, t.branchId, t.parentId)],
);

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** Catalogue embeddings: text-embedding-3-small shortened to 512 dimensions, stored as halfvec. */
export const catalogEmbeddingDimensions = 512;

/** Something the branch sells. Its prices are on its variants. */
export const catalogItem = pgTable(
  "catalog_item",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    typeId: text("type_id")
      .notNull()
      .references(() => catalogType.id),
    categoryId: text("category_id").references(() => catalogCategory.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** Field values by field key, in their real JSON types (number, boolean, string, string[]). */
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    status: catalogItemStatus("status").notNull().default("active"),
    tags: text("tags").array().notNull().default([]),
    /** Where it came from: "manual", "import", later "shopify", "woocommerce", "api". */
    source: text("source").notNull().default("manual"),
    /** Its id in that source, so imports and syncs update instead of duplicating. */
    externalId: text("external_id"),
    /** Category path, type and field values in words, for search ("Bedrooms: 2. Furnished: yes."). */
    searchText: text("search_text").notNull().default(""),
    embedding: halfvec("embedding", { dimensions: catalogEmbeddingDimensions }),
    // "simple" keeps every word (no English stemming), so Hindi, Arabic and mixed text still match.
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(search_text, ''))`,
    ),
    /** Bumped by every change that affects search; the embedding job skips stale revisions. */
    revision: integer("revision").notNull().default(1),
    embeddedRevision: integer("embedded_revision").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("catalog_item_branch_idx").on(t.organizationId, t.branchId, t.status, t.categoryId),
    index("catalog_item_updated_idx").on(t.organizationId, t.branchId, t.updatedAt),
    index("catalog_item_attributes_idx").using("gin", sql`${t.attributes} jsonb_path_ops`),
    index("catalog_item_tsv_idx").using("gin", t.tsv),
    uniqueIndex("catalog_item_external_uidx")
      .on(t.organizationId, t.branchId, t.source, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index("catalog_item_embed_idx")
      .on(t.organizationId, t.branchId)
      .where(sql`${t.embeddedRevision} < ${t.revision}`),
  ],
);

/** A sellable unit of an item: "60 min", "Grey / 3-seater", "Annual lease". */
export const catalogVariant = pgTable(
  "catalog_variant",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => catalogItem.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    /** Empty for an item's only variant. */
    title: text("title").notNull().default(""),
    sku: text("sku"),
    /** In minor units (fils, paise, cents). Null: "price on request". */
    priceMinor: bigint("price_minor", { mode: "number" }),
    currency: text("currency").notNull(),
    salePriceMinor: bigint("sale_price_minor", { mode: "number" }),
    /** Values of the type's per-variant fields, by key. */
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    /** Null: stock isn't tracked. */
    stock: integer("stock"),
    available: boolean("available").notNull().default(true),
    /** Services: how long one takes. */
    durationMinutes: integer("duration_minutes"),
    /** Services: can be booked. */
    bookable: boolean("bookable").notNull().default(false),
    /** Services: how many can be booked at the same time (tables, chairs). */
    bookingCapacity: integer("booking_capacity").notNull().default(1),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("catalog_variant_item_idx").on(t.itemId, t.position),
    index("catalog_variant_price_idx").on(t.organizationId, t.branchId, t.priceMinor),
    uniqueIndex("catalog_variant_sku_uidx")
      .on(t.organizationId, t.branchId, t.sku)
      .where(sql`${t.sku} is not null`),
  ],
);

/** One file in an item's gallery. The primary one is the card photo everywhere. */
export const catalogMedia = pgTable(
  "catalog_media",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => catalogItem.id, { onDelete: "cascade" }),
    /** Only for that variant (the grey sofa's photos); null for the whole item. */
    variantId: text("variant_id").references(() => catalogVariant.id, { onDelete: "cascade" }),
    /** The WhatsApp-ready stored file; null while it is being prepared. */
    fileId: text("file_id").references(() => storedFile.id, { onDelete: "cascade" }),
    /** Where the original upload waits while it is prepared. */
    uploadKey: text("upload_key"),
    kind: catalogMediaKind("kind").notNull(),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** Space held for the upload until the prepared file's real size is known. */
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
    position: integer("position").notNull().default(0),
    isPrimary: boolean("is_primary").notNull().default(false),
    caption: text("caption"),
    status: catalogMediaStatus("status").notNull().default("processing"),
    error: text("error"),
    durationSeconds: integer("duration_seconds"),
    width: integer("width"),
    height: integer("height"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("catalog_media_item_idx").on(t.itemId, t.position),
    index("catalog_media_file_idx").on(t.fileId),
    uniqueIndex("catalog_media_primary_uidx")
      .on(t.itemId)
      .where(sql`${t.isPrimary} and ${t.variantId} is null`),
  ],
);

/** An Excel or CSV import into a branch's catalogue. Same steps as contact imports. */
export const catalogImport = pgTable(
  "catalog_import",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branch.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    typeId: text("type_id").references(() => catalogType.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    sheet: text("sheet"),
    sheets: jsonb("sheets").$type<unknown[]>(),
    readError: text("read_error"),
    /** Column header → target ("title", "price", "field:bedrooms", "skip"…). */
    mapping: jsonb("mapping").$type<Record<string, unknown>>(),
    status: importStatus("status").notNull().default("reading"),
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    errors: jsonb("errors")
      .$type<{ row: number; reason: string; values?: unknown[] }[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("catalog_import_org_idx").on(t.organizationId, t.branchId, t.createdAt)],
);
