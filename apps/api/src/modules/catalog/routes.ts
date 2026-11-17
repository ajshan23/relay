import { newId } from "@relay/core";
import {
  catalogFieldSchema,
  catalogItemSchema,
  catalogTemplates,
  catalogTypeSchema,
  currencySchema,
  formatMoney,
  fromMinor,
  optionsFromLabels,
} from "@relay/core/catalog";
import { fieldKey } from "@relay/core/contacts";
import {
  and,
  asc,
  CatalogInputError,
  createCatalogType,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  saveCatalogItem,
  schema,
  sql,
} from "@relay/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { enqueue } from "../../lib/enqueue";
import { requireSession } from "../auth/session";
import { branchAccess, fail, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { type BranchEnv, requireBranch } from "../contacts/shared";
import { catalogMediaRoutes } from "./media";

/*
 * The selected branch's catalogue (?branch=). Types and their fields are shared by the business;
 * categories and items belong to the branch.
 *   GET    /api/catalog                      types with fields, categories, currency, templates
 *   PUT    /api/catalog/settings             { currency }
 *   POST   /api/catalog/types                { name, kind, template? }
 *   PATCH  /api/catalog/types/:id            { name?, kind? }
 *   DELETE /api/catalog/types/:id            archive (items keep it)
 *   POST   /api/catalog/types/:id/fields     a field
 *   PATCH  /api/catalog/fields/:id           label, choices (added), unit, filterable, required, position
 *   DELETE /api/catalog/fields/:id           archive (values stay on items)
 *   POST|PATCH|DELETE /api/catalog/categories[/:id]
 *   GET    /api/catalog/items                ?q&status&typeId&categoryId&cursor
 *   GET    /api/catalog/items/:id            with variants and gallery
 *   POST   /api/catalog/items                item + variants
 *   PUT    /api/catalog/items/:id            replace item + variants
 *   DELETE /api/catalog/items/:id
 *   POST   /api/catalog/items/bulk           { ids, action: archive | activate | delete }
 *   /api/catalog/media/*                      an item's gallery (media.ts)
 * Owners, admins and the branch's managers change things; anyone in the branch may look.
 */

const PAGE = 50;

export function catalogRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx));
  app.route("/media", catalogMediaRoutes(ctx));
  const T = schema.catalogType;
  const F = schema.catalogField;
  const C = schema.catalogCategory;
  const I = schema.catalogItem;
  const V = schema.catalogVariant;
  const M = schema.catalogMedia;

  async function canManage(c: Context<BranchEnv>) {
    const found = await branchAccess(ctx, c.var.access, c.var.branchId);
    return found?.role === "manager";
  }
  const orgOf = (c: Context<BranchEnv>) => c.var.access.orgId;
  const inBranch = <Tbl extends { organizationId: unknown; branchId: unknown }>(
    c: Context<BranchEnv>,
    t: Tbl,
  ) =>
    and(
      eq(t.organizationId as typeof I.organizationId, orgOf(c)),
      eq(t.branchId as typeof I.branchId, c.var.branchId),
    );

  /** Queues embedding of the branch's changed items, at most one job per 10 seconds. */
  const embedSoon = (branchId: string, organizationId: string) =>
    enqueue(
      ctx.queues.catalog,
      "embed",
      { organizationId, branchId },
      {
        jobId: `embed_${branchId}_${Math.floor(Date.now() / 10_000)}`,
        delay: 2_000,
        attempts: 3,
        removeOnComplete: true,
      },
    );

  async function currencyOf(orgId: string) {
    const [row] = await ctx.db
      .select({ catalog: schema.organizationSettings.catalog })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, orgId));
    return row?.catalog?.currency ?? null;
  }

  // ------------------------------------------------------------------ overview and settings

  app.get("/", async (c) => {
    const orgId = orgOf(c);
    const [types, fields, categories, counts] = await Promise.all([
      ctx.db
        .select()
        .from(T)
        .where(and(eq(T.organizationId, orgId), isNull(T.archivedAt)))
        .orderBy(asc(T.position)),
      ctx.db
        .select()
        .from(F)
        .where(and(eq(F.organizationId, orgId), isNull(F.archivedAt)))
        .orderBy(asc(F.position)),
      ctx.db.select().from(C).where(inBranch(c, C)).orderBy(asc(C.position), asc(C.name)),
      ctx.db
        .select({ status: I.status, n: sql<number>`count(*)::int` })
        .from(I)
        .where(inBranch(c, I))
        .groupBy(I.status),
    ]);
    return c.json({
      types: types.map((t) => ({ ...t, fields: fields.filter((f) => f.typeId === t.id) })),
      categories,
      currency: await currencyOf(orgId),
      counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
      templates: catalogTemplates.map(({ id, name, kind, hint }) => ({ id, name, kind, hint })),
      canManage: await canManage(c),
    });
  });

  app.put("/settings", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, z.object({ currency: currencySchema }));
    if ("error" in parsed) return parsed.error;
    const catalog = { currency: parsed.data.currency };
    await ctx.db
      .insert(schema.organizationSettings)
      .values({ organizationId: orgOf(c), catalog })
      .onConflictDoUpdate({
        target: schema.organizationSettings.organizationId,
        set: { catalog, updatedAt: new Date() },
      });
    return c.json({ currency: catalog.currency });
  });

  // ------------------------------------------------------------------ types and fields

  app.post("/types", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, catalogTypeSchema);
    if ("error" in parsed) return parsed.error;
    const type = await createCatalogType(ctx.db, {
      organizationId: orgOf(c),
      ...parsed.data,
      newId: (kind) => newId(kind),
    });
    return c.json({ type }, 201);
  });

  app.patch("/types/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, catalogTypeSchema.pick({ name: true, kind: true }).partial());
    if ("error" in parsed) return parsed.error;
    const [type] = await ctx.db
      .update(T)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(T.id, c.req.param("id")), eq(T.organizationId, orgOf(c))))
      .returning();
    return type ? c.json({ type }) : fail(c, 404, "not_found");
  });

  app.delete("/types/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [type] = await ctx.db
      .update(T)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(T.id, c.req.param("id")), eq(T.organizationId, orgOf(c))))
      .returning({ id: T.id });
    return type ? c.body(null, 204) : fail(c, 404, "not_found");
  });

  app.post("/types/:id/fields", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, catalogFieldSchema);
    if ("error" in parsed) return parsed.error;
    const typeId = c.req.param("id");
    const [type] = await ctx.db
      .select({ id: T.id })
      .from(T)
      .where(and(eq(T.id, typeId), eq(T.organizationId, orgOf(c))));
    if (!type) return fail(c, 404, "not_found");
    const taken = new Set(
      (await ctx.db.select({ key: F.key }).from(F).where(eq(F.typeId, typeId))).map((r) => r.key),
    );
    let key = fieldKey(parsed.data.label);
    for (let n = 2; taken.has(key); n++) key = `${fieldKey(parsed.data.label)}_${n}`;
    const [{ next } = { next: 0 }] = await ctx.db
      .select({ next: sql<number>`coalesce(max(${F.position}), -1)::int + 1` })
      .from(F)
      .where(eq(F.typeId, typeId));
    const [field] = await ctx.db
      .insert(F)
      .values({
        id: newId("catalogField"),
        organizationId: orgOf(c),
        typeId,
        key,
        label: parsed.data.label,
        type: parsed.data.type,
        options: optionsFromLabels(parsed.data.options),
        unit: parsed.data.unit || null,
        onVariant: parsed.data.onVariant,
        filterable: parsed.data.filterable,
        required: parsed.data.required,
        position: next,
      })
      .returning();
    return c.json({ field }, 201);
  });

  app.patch("/fields/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({
        label: z.string().trim().min(1).max(60).optional(),
        /** Choices to add; existing ones keep their stored values. */
        addOptions: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
        unit: z.string().trim().max(20).nullable().optional(),
        filterable: z.boolean().optional(),
        required: z.boolean().optional(),
        position: z.number().int().min(0).max(1000).optional(),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const [cur] = await ctx.db
      .select()
      .from(F)
      .where(and(eq(F.id, c.req.param("id")), eq(F.organizationId, orgOf(c))));
    if (!cur) return fail(c, 404, "not_found");
    const b = parsed.data;
    if (b.filterable && !["number", "boolean", "select", "multi_select", "date"].includes(cur.type))
      return fail(c, 422, "not_filterable", "Only choice, yes/no, number and date fields can be filters.");
    const options = b.addOptions?.length
      ? [
          ...cur.options,
          ...optionsFromLabels([...cur.options.map((o) => o.label), ...b.addOptions]).slice(
            cur.options.length,
          ),
        ]
      : cur.options;
    const [field] = await ctx.db
      .update(F)
      .set({
        ...(b.label ? { label: b.label } : {}),
        ...(b.unit !== undefined ? { unit: b.unit || null } : {}),
        ...(b.filterable !== undefined ? { filterable: b.filterable } : {}),
        ...(b.required !== undefined ? { required: b.required } : {}),
        ...(b.position !== undefined ? { position: b.position } : {}),
        options,
        updatedAt: new Date(),
      })
      .where(eq(F.id, cur.id))
      .returning();
    return c.json({ field });
  });

  app.delete("/fields/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [field] = await ctx.db
      .update(F)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(F.id, c.req.param("id")), eq(F.organizationId, orgOf(c))))
      .returning({ id: F.id });
    return field ? c.body(null, 204) : fail(c, 404, "not_found");
  });

  // ------------------------------------------------------------------ categories

  const categoryBody = z.object({
    name: z.string().trim().min(1, "Give the category a name").max(60),
    parentId: z.string().nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  });

  async function parentOk(c: Context<BranchEnv>, parentId: string | null | undefined, selfId?: string) {
    if (!parentId) return true;
    if (parentId === selfId) return false;
    const [p] = await ctx.db
      .select({ id: C.id })
      .from(C)
      .where(and(eq(C.id, parentId), inBranch(c, C)));
    return !!p;
  }

  app.post("/categories", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, categoryBody);
    if ("error" in parsed) return parsed.error;
    if (!(await parentOk(c, parsed.data.parentId)))
      return fail(c, 422, "bad_parent", "That parent category isn't in this branch.");
    const [category] = await ctx.db
      .insert(C)
      .values({
        id: newId("catalogCategory"),
        organizationId: orgOf(c),
        branchId: c.var.branchId,
        name: parsed.data.name,
        parentId: parsed.data.parentId ?? null,
        position: parsed.data.position ?? 0,
      })
      .returning();
    return c.json({ category }, 201);
  });

  app.patch("/categories/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, categoryBody.partial());
    if ("error" in parsed) return parsed.error;
    if (!(await parentOk(c, parsed.data.parentId, c.req.param("id"))))
      return fail(c, 422, "bad_parent", "That parent category isn't in this branch.");
    const [category] = await ctx.db
      .update(C)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(C.id, c.req.param("id")), inBranch(c, C)))
      .returning();
    return category ? c.json({ category }) : fail(c, 404, "not_found");
  });

  app.delete("/categories/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [category] = await ctx.db
      .delete(C)
      .where(and(eq(C.id, c.req.param("id")), inBranch(c, C)))
      .returning({ id: C.id });
    return category ? c.body(null, 204) : fail(c, 404, "not_found");
  });

  // ------------------------------------------------------------------ items

  /** Price range, stock and the primary photo for list rows and cards. */
  async function summaries(itemIds: string[]) {
    if (!itemIds.length) return new Map<string, ItemSummary>();
    const [variants, media] = await Promise.all([
      ctx.db.select().from(V).where(inArray(V.itemId, itemIds)).orderBy(asc(V.position)),
      ctx.db
        .select({ id: M.id, itemId: M.itemId, kind: M.kind, status: M.status })
        .from(M)
        .where(and(inArray(M.itemId, itemIds), eq(M.isPrimary, true), isNull(M.variantId))),
    ]);
    const out = new Map<string, ItemSummary>();
    for (const id of itemIds) {
      const vs = variants.filter((v) => v.itemId === id);
      const prices = vs.map((v) => v.salePriceMinor ?? v.priceMinor).filter((p): p is number => p !== null);
      const currency = vs[0]?.currency ?? null;
      const primary = media.find((m) => m.itemId === id);
      out.set(id, {
        variantCount: vs.length,
        currency,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        priceText: priceRange(prices, currency),
        stock: vs.some((v) => v.stock !== null) ? vs.reduce((s, v) => s + (v.stock ?? 0), 0) : null,
        available: vs.some((v) => v.available && (v.stock === null || v.stock > 0)),
        primaryMedia: primary ? { id: primary.id, kind: primary.kind, status: primary.status } : null,
      });
    }
    return out;
  }

  app.get("/items", async (c) => {
    const q = c.req.query("q")?.trim();
    const status = c.req.query("status");
    const typeId = c.req.query("typeId");
    const categoryId = c.req.query("categoryId");
    const cursor = c.req.query("cursor"); // "<updatedAt ISO>|<id>"
    const conds = [inBranch(c, I)];
    if (status === "active" || status === "draft" || status === "archived") conds.push(eq(I.status, status));
    else conds.push(sql`${I.status} <> 'archived'`);
    if (typeId) conds.push(eq(I.typeId, typeId));
    if (categoryId) conds.push(eq(I.categoryId, categoryId));
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      conds.push(
        or(
          ilike(I.title, like),
          sql`exists (select 1 from ${V} v where v.item_id = ${I.id} and v.sku ilike ${like})`,
          sql`${I.tsv} @@ plainto_tsquery('simple', ${q})`,
        ) as never,
      );
    }
    if (cursor) {
      const [at, id] = cursor.split("|");
      if (at && id)
        conds.push(
          or(lt(I.updatedAt, new Date(at)), and(eq(I.updatedAt, new Date(at)), lt(I.id, id))) as never,
        );
    }
    const rows = await ctx.db
      .select({
        id: I.id,
        title: I.title,
        status: I.status,
        typeId: I.typeId,
        categoryId: I.categoryId,
        updatedAt: I.updatedAt,
      })
      .from(I)
      .where(and(...conds))
      .orderBy(desc(I.updatedAt), desc(I.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    const sums = await summaries(page.map((r) => r.id));
    const last = page.at(-1);
    return c.json({
      items: page.map((r) => ({ ...r, ...sums.get(r.id) })),
      nextCursor: rows.length > PAGE && last ? `${last.updatedAt.toISOString()}|${last.id}` : null,
    });
  });

  app.get("/items/:id", async (c) => {
    const [item] = await ctx.db
      .select()
      .from(I)
      .where(and(eq(I.id, c.req.param("id")), inBranch(c, I)));
    if (!item) return fail(c, 404, "not_found");
    const [variants, media] = await Promise.all([
      ctx.db.select().from(V).where(eq(V.itemId, item.id)).orderBy(asc(V.position)),
      ctx.db.select().from(M).where(eq(M.itemId, item.id)).orderBy(asc(M.position)),
    ]);
    const { embedding: _e, tsv: _t, ...rest } = item;
    return c.json({
      item: {
        ...rest,
        variants: variants.map((v) => ({
          ...v,
          price: v.priceMinor === null ? null : fromMinor(v.priceMinor, v.currency),
          salePrice: v.salePriceMinor === null ? null : fromMinor(v.salePriceMinor, v.currency),
        })),
        media,
      },
    });
  });

  async function save(c: Context<BranchEnv>, itemId?: string) {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, catalogItemSchema);
    if ("error" in parsed) return parsed.error;
    try {
      const item = await saveCatalogItem(ctx.db, {
        organizationId: orgOf(c),
        branchId: c.var.branchId,
        userId: c.var.access.userId,
        itemId,
        input: parsed.data,
        newId: (kind) => newId(kind),
      });
      await embedSoon(c.var.branchId, orgOf(c));
      return c.json({ item: { id: item.id, title: item.title, status: item.status } }, itemId ? 200 : 201);
    } catch (err) {
      if (err instanceof CatalogInputError) return fail(c, 422, "invalid_item", err.message);
      throw err;
    }
  }
  app.post("/items", (c) => save(c));
  app.put("/items/:id", (c) => save(c, c.req.param("id")));

  app.delete("/items/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [item] = await ctx.db
      .delete(I)
      .where(and(eq(I.id, c.req.param("id")), inBranch(c, I)))
      .returning({ id: I.id });
    return item ? c.body(null, 204) : fail(c, 404, "not_found");
  });

  app.post("/items/bulk", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({
        ids: z.array(z.string()).min(1).max(500),
        action: z.enum(["archive", "activate", "delete"]),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const where = and(inArray(I.id, parsed.data.ids), inBranch(c, I));
    const rows =
      parsed.data.action === "delete"
        ? await ctx.db.delete(I).where(where).returning({ id: I.id })
        : await ctx.db
            .update(I)
            .set({
              status: parsed.data.action === "archive" ? "archived" : "active",
              updatedAt: new Date(),
            })
            .where(where)
            .returning({ id: I.id });
    return c.json({ changed: rows.length });
  });

  return app;
}

export type ItemSummary = {
  variantCount: number;
  currency: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  priceText: string | null;
  stock: number | null;
  available: boolean;
  primaryMedia: { id: string; kind: string; status: string } | null;
};

/** "AED 1,200", "AED 900 – 1,400", or null when there's no price. */
export function priceRange(prices: number[], currency: string | null) {
  if (!prices.length || !currency) return null;
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi
    ? formatMoney(lo, currency)
    : `${formatMoney(lo, currency)} – ${formatMoney(hi, currency).replace(/^[A-Z]{3}\s/, "")}`;
}
