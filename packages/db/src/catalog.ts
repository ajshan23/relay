import {
  type CatalogFieldDef,
  type CatalogItemInput,
  catalogSearchText,
  catalogTemplates,
  cleanCatalogValues,
  optionsFromLabels,
  toMinor,
} from "@relay/core/catalog";
import { fieldKey } from "@relay/core/contacts";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { createDb } from "./client";
import { catalogCategory, catalogField, catalogItem, catalogType, catalogVariant } from "./schema/catalog";

/*
 * Saving catalogue items, shared by the API and the import worker so both check items the same way:
 * field values against the item's type, prices into minor units, and the words it is searched by.
 */

type Db = ReturnType<typeof createDb>["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Something wrong with what was sent; the message is for people. */
export class CatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogInputError";
  }
}

export function toFieldDef(f: typeof catalogField.$inferSelect): CatalogFieldDef {
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    options: f.options,
    unit: f.unit,
    onVariant: f.onVariant,
    filterable: f.filterable,
    required: f.required,
  };
}

/** A type and its active fields, in order. */
export async function loadCatalogType(db: Db | Tx, organizationId: string, typeId: string) {
  const [type] = await db
    .select()
    .from(catalogType)
    .where(and(eq(catalogType.id, typeId), eq(catalogType.organizationId, organizationId)))
    .limit(1);
  if (!type) return null;
  const fields = await db
    .select()
    .from(catalogField)
    .where(and(eq(catalogField.typeId, typeId), isNull(catalogField.archivedAt)))
    .orderBy(asc(catalogField.position));
  return { type, fields };
}

/** Category names from the top down to this one ("Living", "Sofas"). */
export async function categoryPath(
  db: Db | Tx,
  organizationId: string,
  branchId: string,
  categoryId: string | null,
) {
  if (!categoryId) return [];
  const rows = await db
    .select({ id: catalogCategory.id, parentId: catalogCategory.parentId, name: catalogCategory.name })
    .from(catalogCategory)
    .where(and(eq(catalogCategory.organizationId, organizationId), eq(catalogCategory.branchId, branchId)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path: string[] = [];
  for (let id: string | null = categoryId, guard = 0; id && guard < 10; guard++) {
    const row = byId.get(id);
    if (!row) break;
    path.unshift(row.name);
    id = row.parentId;
  }
  return path;
}

/** Makes a type (blank or from a template) with its fields. */
export async function createCatalogType(
  db: Db,
  input: {
    organizationId: string;
    name: string;
    kind: "product" | "service" | "other";
    template?: string;
    newId: (kind: "catalogType" | "catalogField") => string;
  },
) {
  const template = catalogTemplates.find((t) => t.id === input.template);
  return db.transaction(async (tx) => {
    const [{ next } = { next: 0 }] = await tx
      .select({ next: sql<number>`coalesce(max(${catalogType.position}), -1)::int + 1` })
      .from(catalogType)
      .where(eq(catalogType.organizationId, input.organizationId));
    const [type] = await tx
      .insert(catalogType)
      .values({
        id: input.newId("catalogType"),
        organizationId: input.organizationId,
        name: input.name,
        kind: template?.kind ?? input.kind,
        template: template?.id ?? null,
        position: next,
      })
      .returning();
    if (!type) throw new Error("type not saved");
    const used = new Set<string>();
    for (const [i, f] of (template?.fields ?? []).entries()) {
      let key = fieldKey(f.label);
      for (let n = 2; used.has(key); n++) key = `${fieldKey(f.label)}_${n}`;
      used.add(key);
      await tx.insert(catalogField).values({
        id: input.newId("catalogField"),
        organizationId: input.organizationId,
        typeId: type.id,
        key,
        label: f.label,
        type: f.type,
        options: optionsFromLabels(f.options ?? []),
        unit: f.unit ?? null,
        onVariant: f.onVariant ?? false,
        filterable: f.filterable ?? false,
        required: f.required ?? false,
        position: i,
      });
    }
    return type;
  });
}

/**
 * Creates or replaces an item with its variants, in one transaction. Variants sent with an id are
 * updated, without one are added, and ones not sent are removed. Bumps the revision so the item is
 * embedded again. Throws CatalogInputError for anything people need to fix.
 */
export async function saveCatalogItem(
  db: Db,
  args: {
    organizationId: string;
    branchId: string;
    userId: string | null;
    /** Replace this item; omit to create. */
    itemId?: string;
    input: CatalogItemInput;
    source?: string;
    externalId?: string | null;
    newId: (kind: "catalogItem" | "catalogVariant") => string;
  },
) {
  const { organizationId, branchId, input } = args;
  return db.transaction(async (tx) => {
    const loaded = await loadCatalogType(tx, organizationId, input.typeId);
    if (!loaded || loaded.type.archivedAt) throw new CatalogInputError("Pick a type for this item.");
    const fields = loaded.fields.map(toFieldDef);
    if (input.categoryId) {
      const [cat] = await tx
        .select({ id: catalogCategory.id })
        .from(catalogCategory)
        .where(
          and(
            eq(catalogCategory.id, input.categoryId),
            eq(catalogCategory.organizationId, organizationId),
            eq(catalogCategory.branchId, branchId),
          ),
        );
      if (!cat) throw new CatalogInputError("That category isn't in this branch.");
    }
    const attrs = cleanCatalogValues(fields, input.attributes, "item");
    if (!attrs.ok) throw new CatalogInputError(attrs.message);
    const variants = input.variants.map((v, i) => {
      const opts = cleanCatalogValues(fields, v.options, "variant");
      if (!opts.ok) throw new CatalogInputError(opts.message);
      const price = (amount: number | string | null | undefined, what: string) => {
        if (amount === null || amount === undefined || amount === "") return null;
        try {
          return toMinor(amount, v.currency);
        } catch {
          throw new CatalogInputError(`${what}: expected an amount of 0 or more.`);
        }
      };
      const priceMinor = price(v.price, "Price");
      const salePriceMinor = price(v.salePrice, "Sale price");
      if (salePriceMinor !== null && (priceMinor === null || salePriceMinor >= priceMinor))
        throw new CatalogInputError("A sale price must be lower than the price.");
      return {
        id: v.id,
        title: v.title,
        sku: v.sku?.trim() || null,
        priceMinor,
        salePriceMinor,
        currency: v.currency,
        options: opts.values,
        stock: v.stock ?? null,
        available: v.available,
        durationMinutes: v.durationMinutes ?? null,
        bookable: v.bookable,
        position: i,
      };
    });
    const searchText = catalogSearchText({
      typeName: loaded.type.name,
      categoryPath: await categoryPath(tx, organizationId, branchId, input.categoryId ?? null),
      fields,
      attributes: attrs.values,
      variants: variants.map((v) => ({ title: v.title, options: v.options })),
      tags: input.tags,
    });
    const values = {
      typeId: input.typeId,
      categoryId: input.categoryId ?? null,
      title: input.title,
      description: input.description,
      attributes: attrs.values,
      status: input.status,
      tags: input.tags,
      searchText,
      updatedAt: new Date(),
    };
    let item: typeof catalogItem.$inferSelect | undefined;
    if (args.itemId) {
      [item] = await tx
        .update(catalogItem)
        .set({ ...values, revision: sql`${catalogItem.revision} + 1` })
        .where(
          and(
            eq(catalogItem.id, args.itemId),
            eq(catalogItem.organizationId, organizationId),
            eq(catalogItem.branchId, branchId),
          ),
        )
        .returning();
      if (!item) throw new CatalogInputError("That item isn't in this branch any more.");
    } else {
      [item] = await tx
        .insert(catalogItem)
        .values({
          ...values,
          id: args.newId("catalogItem"),
          organizationId,
          branchId,
          source: args.source ?? "manual",
          externalId: args.externalId ?? null,
          createdByUserId: args.userId,
        })
        .returning();
      if (!item) throw new Error("item not saved");
    }
    const itemId = item.id;
    const keep = variants.map((v) => v.id).filter((id): id is string => !!id);
    await tx
      .delete(catalogVariant)
      .where(
        and(eq(catalogVariant.itemId, itemId), keep.length ? notInArray(catalogVariant.id, keep) : sql`true`),
      );
    const existing = keep.length
      ? new Set(
          (
            await tx
              .select({ id: catalogVariant.id })
              .from(catalogVariant)
              .where(and(eq(catalogVariant.itemId, itemId), inArray(catalogVariant.id, keep)))
          ).map((r) => r.id),
        )
      : new Set<string>();
    try {
      for (const v of variants) {
        const row = { ...v, id: undefined, updatedAt: new Date() };
        if (v.id && existing.has(v.id))
          await tx.update(catalogVariant).set(row).where(eq(catalogVariant.id, v.id));
        else
          await tx.insert(catalogVariant).values({
            ...row,
            id: args.newId("catalogVariant"),
            itemId,
            organizationId,
            branchId,
          });
      }
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string; constraint_name?: string } };
      if (e.code === "23505" || e.cause?.code === "23505")
        throw new CatalogInputError("Another item in this branch already uses that SKU.");
      throw err;
    }
    return item;
  });
}
