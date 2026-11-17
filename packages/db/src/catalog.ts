import {
  type CatalogFieldDef,
  type CatalogItemInput,
  catalogSearchText,
  catalogTemplates,
  cleanCatalogValues,
  fieldValueText,
  formatMoney,
  fromMinor,
  optionsFromLabels,
  toMinor,
} from "@relay/core/catalog";
import { fieldKey } from "@relay/core/contacts";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { createDb } from "./client";
import {
  catalogCategory,
  catalogField,
  catalogItem,
  catalogMedia,
  catalogType,
  catalogVariant,
} from "./schema/catalog";

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

/* ------------------------------------------------------------------ search */

/** A field filter: a choice value (or label), yes/no, several choices, or a number/date range. */
export type CatalogFieldFilter =
  | string
  | number
  | boolean
  | string[]
  | { min?: number | string; max?: number | string };

export type CatalogSearchFilters = {
  /** A category id; its sub-categories count too. */
  categoryId?: string;
  /** Major units ("under 2000" = priceMax 2000), compared with the sale price when there is one. */
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  inStock?: boolean;
  /** By field key; only filterable fields are used, anything else is reported back as ignored. */
  fields?: Record<string, CatalogFieldFilter>;
};

/** One item as Mira and the cards see it: facts and prices only, nothing to guess. */
export type CatalogCard = {
  id: string;
  title: string;
  description: string;
  type: string;
  category: string | null;
  /** Field values in words: "Bedrooms: 2", "Area: 1,450 sq ft". */
  details: string[];
  priceText: string | null;
  variants: {
    id: string;
    title: string;
    price: { amount: number; currency: string; text: string } | null;
    salePrice: { amount: number; currency: string; text: string } | null;
    available: boolean;
    stock: number | null;
    durationMinutes: number | null;
    details: string[];
  }[];
  primaryMediaId: string | null;
  mediaCount: number;
};

function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as T[];
}

/**
 * Finds a branch's active items. Exact filters first (category, price, stock, field values), then, if
 * there are words, ranks what's left by full-text and meaning together (reciprocal-rank fusion), with
 * exact distance on those rows only. Without words, returns the newest matches. `terms` is a safe
 * to_tsquery string (searchTerms in @relay/agent); `embedding` is 512-dim or null.
 */
export async function searchCatalog(
  db: Db,
  args: {
    organizationId: string;
    branchId: string;
    terms?: string | null;
    embedding?: number[] | null;
    filters?: CatalogSearchFilters;
    limit?: number;
  },
): Promise<{ ids: string[]; ignoredFilters: string[] }> {
  const { organizationId, branchId } = args;
  const f = args.filters ?? {};
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const conds = [
    sql`i.organization_id = ${organizationId}`,
    sql`i.branch_id = ${branchId}`,
    sql`i.status = 'active'`,
  ];
  const ignored: string[] = [];

  if (f.categoryId) {
    const cats = await db
      .select({ id: catalogCategory.id, parentId: catalogCategory.parentId })
      .from(catalogCategory)
      .where(and(eq(catalogCategory.organizationId, organizationId), eq(catalogCategory.branchId, branchId)));
    const ids = new Set([f.categoryId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of cats)
        if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
          ids.add(c.id);
          grew = true;
        }
    }
    conds.push(
      sql`i.category_id in (${sql.join(
        [...ids].map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }

  // Variant conditions all apply to the same variant ("a grey one under 2000 in stock").
  const vconds: ReturnType<typeof sql>[] = [];
  const price = sql`coalesce(v.sale_price_minor, v.price_minor)`;
  const minor = (amount: number, currency: string) => {
    try {
      return toMinor(amount, currency);
    } catch {
      return null;
    }
  };
  if (f.priceMin !== undefined || f.priceMax !== undefined) {
    const currency = f.currency ?? null;
    const scale = currency
      ? sql`${10 ** currencyDigitsOf(currency)}`
      : sql`power(10, case when v.currency in ('JPY','KRW','VND','CLP','ISK','UGX') then 0 when v.currency in ('KWD','BHD','OMR','JOD','TND','LYD','IQD') then 3 else 2 end)`;
    if (currency) vconds.push(sql`v.currency = ${currency}`);
    if (f.priceMin !== undefined) {
      const m = currency ? minor(f.priceMin, currency) : null;
      vconds.push(m !== null ? sql`${price} >= ${m}` : sql`${price} >= ${f.priceMin} * ${scale}`);
    }
    if (f.priceMax !== undefined) {
      const m = currency ? minor(f.priceMax, currency) : null;
      vconds.push(m !== null ? sql`${price} <= ${m}` : sql`${price} <= ${f.priceMax} * ${scale}`);
    }
  }
  if (f.inStock) vconds.push(sql`v.available and (v.stock is null or v.stock > 0)`);

  const filterKeys = Object.keys(f.fields ?? {});
  if (filterKeys.length) {
    const defs = await db
      .select()
      .from(catalogField)
      .where(
        and(
          eq(catalogField.organizationId, organizationId),
          isNull(catalogField.archivedAt),
          eq(catalogField.filterable, true),
          inArray(catalogField.key, filterKeys),
        ),
      );
    for (const key of filterKeys) {
      const raw = f.fields?.[key];
      const matching = defs.filter((d) => d.key === key);
      const def = matching[0];
      if (!def || raw === undefined || raw === null) {
        ignored.push(key);
        continue;
      }
      const col = def.onVariant ? sql`v.options` : sql`i.attributes`;
      const optionValue = (x: unknown) => {
        const s = String(x).trim().toLowerCase();
        return def.options.find((o) => o.value === s || o.label.toLowerCase() === s)?.value ?? null;
      };
      let cond: ReturnType<typeof sql> | null = null;
      if (def.type === "boolean") {
        const b = typeof raw === "boolean" ? raw : ["yes", "true", "1"].includes(String(raw).toLowerCase());
        cond = sql`${col} @> ${JSON.stringify({ [key]: b })}::jsonb`;
      } else if (def.type === "select" || def.type === "multi_select") {
        const wanted = (Array.isArray(raw) ? raw : [raw]).map(optionValue).filter((v): v is string => !!v);
        if (!wanted.length) {
          ignored.push(key);
          continue;
        }
        cond =
          def.type === "select"
            ? sql`(${sql.join(
                wanted.map((v) => sql`${col} @> ${JSON.stringify({ [key]: v })}::jsonb`),
                sql` or `,
              )})`
            : sql`${col} @> ${JSON.stringify({ [key]: wanted })}::jsonb`;
      } else if (def.type === "number" || def.type === "date") {
        const range =
          typeof raw === "object" && !Array.isArray(raw)
            ? raw
            : { min: raw as number | string, max: raw as number | string };
        const parts: ReturnType<typeof sql>[] = [];
        const value =
          def.type === "number"
            ? sql`case when jsonb_typeof(${col} -> ${key}) = 'number' then (${col} ->> ${key})::numeric end`
            : sql`(${col} ->> ${key})`;
        const num = (x: unknown) => (def.type === "number" ? Number(x) : String(x));
        if (
          range.min !== undefined &&
          range.min !== "" &&
          (def.type !== "number" || Number.isFinite(Number(range.min)))
        )
          parts.push(sql`${value} >= ${num(range.min)}`);
        if (
          range.max !== undefined &&
          range.max !== "" &&
          (def.type !== "number" || Number.isFinite(Number(range.max)))
        )
          parts.push(sql`${value} <= ${num(range.max)}`);
        if (!parts.length) {
          ignored.push(key);
          continue;
        }
        cond = sql.join(parts, sql` and `);
      } else {
        ignored.push(key);
        continue;
      }
      if (def.onVariant) vconds.push(cond);
      else conds.push(cond);
    }
  }
  if (vconds.length)
    conds.push(
      sql`exists (select 1 from ${catalogVariant} v where v.item_id = i.id and ${sql.join(vconds, sql` and `)})`,
    );

  const where = sql.join(conds, sql` and `);
  const words = args.terms?.trim() ? args.terms.trim() : null;
  const vector = args.embedding?.length ? `[${args.embedding.join(",")}]` : null;
  let res: unknown;
  if (!words && !vector) {
    res = await db.execute(sql`
      select i.id from ${catalogItem} i where ${where}
      order by i.updated_at desc, i.id limit ${limit}`);
  } else {
    // Each leg ranks the filtered rows; an item found by both comes first. Exact distance, no index.
    const kw = words
      ? sql`select i.id, row_number() over (order by ts_rank(i.tsv, q) desc) as r
            from ${catalogItem} i, to_tsquery('simple', ${words}) q
            where ${where} and i.tsv @@ q limit 50`
      : null;
    const vec = vector
      ? sql`select i.id, row_number() over (order by i.embedding <=> ${vector}::halfvec) as r
            from ${catalogItem} i
            where ${where} and i.embedding is not null
              and 1 - (i.embedding <=> ${vector}::halfvec) >= 0.2
            limit 50`
      : null;
    const legs = [kw, vec].filter((x): x is ReturnType<typeof sql> => !!x);
    res = await db.execute(sql`
      with legs as (${sql.join(
        legs.map((l) => sql`(${l})`),
        sql` union all `,
      )})
      select id, sum(1.0 / (60 + r)) as score from legs group by id
      order by score desc, id limit ${limit}`);
  }
  return { ids: rowsOf<{ id: string }>(res).map((r) => r.id), ignoredFilters: ignored };
}

function currencyDigitsOf(currency: string) {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ??
      2
    );
  } catch {
    return 2;
  }
}

/** Items as cards (facts and prices), in the order of `ids`. Only this branch's items. */
export async function catalogCards(
  db: Db,
  args: { organizationId: string; branchId: string; ids: string[]; descriptionChars?: number },
): Promise<CatalogCard[]> {
  if (!args.ids.length) return [];
  const items = await db
    .select()
    .from(catalogItem)
    .where(
      and(
        inArray(catalogItem.id, args.ids),
        eq(catalogItem.organizationId, args.organizationId),
        eq(catalogItem.branchId, args.branchId),
      ),
    );
  if (!items.length) return [];
  const typeIds = [...new Set(items.map((i) => i.typeId))];
  const [types, fields, variants, media, categories] = await Promise.all([
    db.select().from(catalogType).where(inArray(catalogType.id, typeIds)),
    db
      .select()
      .from(catalogField)
      .where(and(inArray(catalogField.typeId, typeIds), isNull(catalogField.archivedAt)))
      .orderBy(asc(catalogField.position)),
    db
      .select()
      .from(catalogVariant)
      .where(
        inArray(
          catalogVariant.itemId,
          items.map((i) => i.id),
        ),
      )
      .orderBy(asc(catalogVariant.position)),
    db.execute(sql`
      select item_id, count(*)::int as n,
        (array_agg(id order by position) filter (where is_primary and variant_id is null and status = 'ready'))[1] as primary_id
      from catalog_media where item_id in (${sql.join(
        items.map((i) => sql`${i.id}`),
        sql`, `,
      )}) and status = 'ready'
      group by item_id`),
    db
      .select({ id: catalogCategory.id, name: catalogCategory.name, parentId: catalogCategory.parentId })
      .from(catalogCategory)
      .where(
        and(
          eq(catalogCategory.organizationId, args.organizationId),
          eq(catalogCategory.branchId, args.branchId),
        ),
      ),
  ]);
  const mediaBy = new Map(
    rowsOf<{ item_id: string; n: number; primary_id: string | null }>(media).map((m) => [m.item_id, m]),
  );
  const catName = (id: string | null) => {
    const names: string[] = [];
    for (let c = categories.find((x) => x.id === id), g = 0; c && g < 10; g++) {
      names.unshift(c.name);
      c = categories.find((x) => x.id === c?.parentId);
    }
    return names.length ? names.join(" › ") : null;
  };
  const money = (minor: number | null, currency: string) =>
    minor === null
      ? null
      : { amount: fromMinor(minor, currency), currency, text: formatMoney(minor, currency) };
  const cards = items.map((item): CatalogCard => {
    const defs = fields.filter((f) => f.typeId === item.typeId).map(toFieldDef);
    const vs = variants.filter((v) => v.itemId === item.id);
    const prices = vs.map((v) => v.salePriceMinor ?? v.priceMinor).filter((p): p is number => p !== null);
    const currency = vs[0]?.currency ?? null;
    const lo = prices.length ? Math.min(...prices) : null;
    const hi = prices.length ? Math.max(...prices) : null;
    const m = mediaBy.get(item.id);
    const limitText = args.descriptionChars ?? 400;
    return {
      id: item.id,
      title: item.title,
      description:
        item.description.length > limitText
          ? `${item.description.slice(0, limitText).trimEnd()}…`
          : item.description,
      type: types.find((t) => t.id === item.typeId)?.name ?? "",
      category: catName(item.categoryId),
      details: defs
        .filter((d) => !d.onVariant)
        .map((d) => {
          const text = fieldValueText(d, item.attributes[d.key]);
          return text ? `${d.label}: ${text}` : "";
        })
        .filter(Boolean),
      priceText:
        lo === null || !currency
          ? null
          : lo === hi
            ? formatMoney(lo, currency)
            : `${formatMoney(lo, currency)} – ${formatMoney(hi as number, currency).replace(/^[A-Z]{3}\s/, "")}`,
      variants: vs.map((v) => ({
        id: v.id,
        title: v.title,
        price: money(v.priceMinor, v.currency),
        salePrice: money(v.salePriceMinor, v.currency),
        available: v.available && (v.stock === null || v.stock > 0),
        stock: v.stock,
        durationMinutes: v.durationMinutes,
        details: defs
          .filter((d) => d.onVariant)
          .map((d) => {
            const text = fieldValueText(d, v.options[d.key]);
            return text ? `${d.label}: ${text}` : "";
          })
          .filter(Boolean),
      })),
      primaryMediaId: m?.primary_id ?? null,
      mediaCount: m?.n ?? 0,
    };
  });
  const order = new Map(args.ids.map((id, i) => [id, i]));
  return cards.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/**
 * Copies items (with their options, category and gallery) from one branch to another of the same
 * business. Categories are matched by path and made if missing; photos and videos point at the same
 * stored files, so nothing is uploaded or counted twice; the search vector is copied too. A SKU the
 * other branch already uses is left empty on the copy.
 */
export async function copyCatalogItems(
  db: Db,
  args: {
    organizationId: string;
    fromBranchId: string;
    toBranchId: string;
    itemIds: string[];
    userId: string | null;
    newId: (kind: "catalogItem" | "catalogVariant" | "catalogMedia" | "catalogCategory") => string;
  },
) {
  const { organizationId, fromBranchId, toBranchId } = args;
  if (fromBranchId === toBranchId) throw new CatalogInputError("Pick another branch to copy to.");
  return db.transaction(async (tx) => {
    const items = await tx
      .select()
      .from(catalogItem)
      .where(
        and(
          inArray(catalogItem.id, args.itemIds),
          eq(catalogItem.organizationId, organizationId),
          eq(catalogItem.branchId, fromBranchId),
        ),
      );
    if (!items.length) return { copied: 0, skusCleared: 0 };
    const itemIds = items.map((i) => i.id);
    const [variants, media, fromCats, toCats, takenSkus] = await Promise.all([
      tx.select().from(catalogVariant).where(inArray(catalogVariant.itemId, itemIds)),
      tx
        .select()
        .from(catalogMedia)
        .where(and(inArray(catalogMedia.itemId, itemIds), eq(catalogMedia.status, "ready"))),
      tx
        .select()
        .from(catalogCategory)
        .where(
          and(eq(catalogCategory.organizationId, organizationId), eq(catalogCategory.branchId, fromBranchId)),
        ),
      tx
        .select()
        .from(catalogCategory)
        .where(
          and(eq(catalogCategory.organizationId, organizationId), eq(catalogCategory.branchId, toBranchId)),
        ),
      tx
        .select({ sku: catalogVariant.sku })
        .from(catalogVariant)
        .where(
          and(eq(catalogVariant.organizationId, organizationId), eq(catalogVariant.branchId, toBranchId)),
        ),
    ]);
    const taken = new Set(takenSkus.map((r) => r.sku).filter(Boolean));
    const pathOf = (id: string | null) => {
      const names: string[] = [];
      for (let c = fromCats.find((x) => x.id === id), g = 0; c && g < 10; g++) {
        names.unshift(c.name);
        c = fromCats.find((x) => x.id === c?.parentId);
      }
      return names;
    };
    const catIn = async (names: string[]) => {
      let parentId: string | null = null;
      for (const name of names) {
        const under: string | null = parentId;
        let found: typeof catalogCategory.$inferSelect | undefined = toCats.find(
          (c) => c.parentId === under && c.name.toLowerCase() === name.toLowerCase(),
        );
        if (!found) {
          const made: (typeof catalogCategory.$inferSelect)[] = await tx
            .insert(catalogCategory)
            .values({
              id: args.newId("catalogCategory"),
              organizationId,
              branchId: toBranchId,
              name,
              parentId: under,
            })
            .returning();
          found = made[0];
          if (!found) return null;
          toCats.push(found);
        }
        parentId = found.id;
      }
      return parentId;
    };
    let skusCleared = 0;
    for (const item of items) {
      const newItemId = args.newId("catalogItem");
      const { id: _i, branchId: _b, createdAt: _c, updatedAt: _u, tsv: _t, externalId: _e, ...rest } = item;
      await tx.insert(catalogItem).values({
        ...rest,
        id: newItemId,
        branchId: toBranchId,
        categoryId: item.categoryId ? await catIn(pathOf(item.categoryId)) : null,
        source: "manual",
        externalId: null,
        createdByUserId: args.userId,
      });
      const variantIds = new Map<string, string>();
      for (const v of variants.filter((x) => x.itemId === item.id)) {
        const id = args.newId("catalogVariant");
        variantIds.set(v.id, id);
        let sku = v.sku;
        if (sku && taken.has(sku)) {
          sku = null;
          skusCleared++;
        }
        if (sku) taken.add(sku);
        const { id: _v, itemId: _it, branchId: _vb, createdAt: _vc, updatedAt: _vu, ...vrest } = v;
        await tx
          .insert(catalogVariant)
          .values({ ...vrest, id, itemId: newItemId, branchId: toBranchId, sku });
      }
      for (const m of media.filter((x) => x.itemId === item.id)) {
        const { id: _m, itemId: _mi, branchId: _mb, variantId, createdAt: _mc, updatedAt: _mu, ...mrest } = m;
        await tx.insert(catalogMedia).values({
          ...mrest,
          id: args.newId("catalogMedia"),
          itemId: newItemId,
          branchId: toBranchId,
          variantId: variantId ? (variantIds.get(variantId) ?? null) : null,
          uploadKey: null,
          reservedBytes: 0,
        });
      }
    }
    return { copied: items.length, skusCleared };
  });
}

/* ------------------------------------------------------------------ for the AI agent */

/**
 * What a branch sells, for the agent's tool descriptions: categories by path, the business's
 * filterable fields and types, the currency. Null when the branch has no active items (no tools then).
 */
export async function catalogShape(db: Db, organizationId: string, branchId: string) {
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(catalogItem)
    .where(
      and(
        eq(catalogItem.organizationId, organizationId),
        eq(catalogItem.branchId, branchId),
        eq(catalogItem.status, "active"),
      ),
    );
  if (!count?.n) return null;
  const [types, fields, categories, settings] = await Promise.all([
    db
      .select({ name: catalogType.name })
      .from(catalogType)
      .where(and(eq(catalogType.organizationId, organizationId), isNull(catalogType.archivedAt))),
    db
      .select()
      .from(catalogField)
      .where(
        and(
          eq(catalogField.organizationId, organizationId),
          eq(catalogField.filterable, true),
          isNull(catalogField.archivedAt),
        ),
      )
      .orderBy(asc(catalogField.position)),
    db
      .select({ id: catalogCategory.id, name: catalogCategory.name, parentId: catalogCategory.parentId })
      .from(catalogCategory)
      .where(and(eq(catalogCategory.organizationId, organizationId), eq(catalogCategory.branchId, branchId))),
    db.execute(sql`select catalog from organization_settings where organization_id = ${organizationId}`),
  ]);
  const path = (id: string) => {
    const names: string[] = [];
    for (let c = categories.find((x) => x.id === id), g = 0; c && g < 10; g++) {
      names.unshift(c.name);
      c = categories.find((x) => x.id === c?.parentId);
    }
    return names.join(" › ");
  };
  const seen = new Set<string>();
  return {
    itemCount: count.n,
    currency: (rowsOf<{ catalog: { currency?: string } | null }>(settings)[0]?.catalog?.currency ?? null) as
      | string
      | null,
    types: types.map((t) => t.name),
    categories: categories
      .map((c) => ({ id: c.id, path: path(c.id) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    fields: fields
      .filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)))
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type as "number" | "boolean" | "select" | "multi_select" | "date",
        options: f.options.map((o) => o.label),
        unit: f.unit,
      })),
  };
}

/**
 * The agent's catalogue tools' data access for one branch. `embed` makes a 512-dim query vector (or
 * null without AI); `terms` turns words into a safe to_tsquery string.
 */
export function catalogAgentDeps(
  db: Db,
  args: {
    organizationId: string;
    branchId: string;
    shape: NonNullable<Awaited<ReturnType<typeof catalogShape>>>;
    embed: ((text: string) => Promise<number[] | null>) | null;
    terms: (query: string) => string | null;
  },
) {
  const { organizationId, branchId } = args;
  return {
    shape: args.shape,
    async search(input: {
      query?: string;
      category?: string;
      priceMin?: number;
      priceMax?: number;
      inStock?: boolean;
      filters?: Record<string, unknown>;
      limit?: number;
    }) {
      const q = input.query?.trim() ?? "";
      const embedding = q && args.embed ? await args.embed(q).catch(() => null) : null;
      const found = await searchCatalog(db, {
        organizationId,
        branchId,
        terms: q ? args.terms(q) : null,
        embedding,
        filters: {
          categoryId: input.category,
          priceMin: input.priceMin,
          priceMax: input.priceMax,
          currency: args.shape.currency ?? undefined,
          inStock: input.inStock,
          fields: input.filters as CatalogSearchFilters["fields"],
        },
        limit: input.limit ?? 6,
      });
      const cards = await catalogCards(db, {
        organizationId,
        branchId,
        ids: found.ids,
        descriptionChars: 160,
      });
      return {
        ignoredFilters: found.ignoredFilters,
        items: cards.map((c) => ({
          id: c.id,
          title: c.title,
          summary: [c.category, ...c.details, c.description].filter(Boolean).join(". ").slice(0, 300),
          price: c.priceText,
          available: c.variants.some((v) => v.available),
          options: c.variants.length,
          hasPhoto: !!c.primaryMediaId,
        })),
      };
    },
    async get(itemId: string) {
      const [card] = await catalogCards(db, {
        organizationId,
        branchId,
        ids: [itemId],
        descriptionChars: 1500,
      });
      if (!card) return null;
      const { primaryMediaId, ...rest } = card;
      return { ...rest, hasPhoto: !!primaryMediaId };
    },
  };
}
