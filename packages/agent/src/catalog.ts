import { z } from "zod";
import { defineTool } from "./tools";
import type { AgentTool, RunContext } from "./types";

/*
 * The catalogue tools: find items with exact filters, read one in full, and show items (or one item's
 * photos and videos) to the customer. The app decides how they look on WhatsApp. Prices only ever come
 * from these results, as numbers with their currency, so the model has nothing to invent.
 */

export const catalogToolNames = {
  search: "search_catalog",
  get: "get_item",
  show: "show_items",
  media: "show_item_media",
} as const;

/** What the business sells, for the tool descriptions: the model writes exact filters from this. */
export type CatalogShape = {
  currency: string | null;
  categories: { id: string; path: string }[];
  /** Filterable fields across the business's types. */
  fields: {
    key: string;
    label: string;
    type: "number" | "boolean" | "select" | "multi_select" | "date";
    options: string[];
    unit?: string | null;
  }[];
  types: string[];
};

export type CatalogSearchInput = {
  query?: string;
  category?: string;
  priceMin?: number;
  priceMax?: number;
  inStock?: boolean;
  filters?: Record<string, unknown>;
  limit?: number;
};

/** The compact result a search gives the model. */
export type CatalogHit = {
  id: string;
  title: string;
  summary: string;
  price: string | null;
  available: boolean;
  options: number;
  hasPhoto: boolean;
};

export type CatalogDeps = {
  shape: CatalogShape;
  search: (
    input: CatalogSearchInput,
    ctx: RunContext,
  ) => Promise<{ items: CatalogHit[]; ignoredFilters: string[] }>;
  get: (itemId: string, ctx: RunContext) => Promise<unknown | null>;
};

function describeShape(shape: CatalogShape) {
  const lines: string[] = [];
  if (shape.types.length) lines.push(`Kinds of items: ${shape.types.join(", ")}.`);
  if (shape.categories.length)
    lines.push(
      `Categories (use the id): ${shape.categories
        .slice(0, 60)
        .map((c) => `${c.path} = ${c.id}`)
        .join("; ")}.`,
    );
  if (shape.fields.length)
    lines.push(
      `Filters by key: ${shape.fields
        .slice(0, 40)
        .map((f) => {
          if (f.type === "number")
            return `${f.key} (number${f.unit ? `, ${f.unit}` : ""}; exact or {min,max})`;
          if (f.type === "boolean") return `${f.key} (true/false)`;
          if (f.type === "date") return `${f.key} (date YYYY-MM-DD or {min,max})`;
          return `${f.key} (one of: ${f.options.slice(0, 15).join(", ")})`;
        })
        .join("; ")}.`,
    );
  if (shape.currency) lines.push(`Prices are in ${shape.currency} unless an item says otherwise.`);
  return lines.join(" ");
}

export function catalogTools(deps: CatalogDeps): AgentTool<unknown>[] {
  const ids = z.array(z.string().min(3).max(60));
  return [
    defineTool({
      name: catalogToolNames.search,
      kind: "read",
      description: `Find items the business sells. Use it for any question about products, services, prices, sizes, availability or "do you have…". Put exact wishes in filters (price, category, field values) and the rest in query. ${describeShape(deps.shape)}`,
      input: z.object({
        query: z
          .string()
          .max(200)
          .optional()
          .describe("Words for what they want, e.g. 'grey sofa for small room'"),
        category: z.string().max(60).optional().describe("A category id from the list"),
        priceMin: z.number().min(0).optional(),
        priceMax: z.number().min(0).optional().describe("Under/at most this price, in normal units"),
        inStock: z.boolean().optional().describe("Only items that can be bought now"),
        filters: z
          .record(
            z.string(),
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.string()),
              z.object({ min: z.number().optional(), max: z.number().optional() }),
            ]),
          )
          .optional()
          .describe("Field filters by key, e.g. { bedrooms: 2, purpose: 'Rent', area: { min: 1000 } }"),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      run: async (input, ctx) => {
        const res = await deps.search(input, ctx);
        if (!res.items.length)
          return {
            found: false,
            items: [],
            ...(res.ignoredFilters.length ? { ignoredFilters: res.ignoredFilters } : {}),
            hint: "Nothing matches. Say so, suggest loosening a filter, or offer a person. Never invent an item or a price.",
          };
        return {
          found: true,
          items: res.items,
          ...(res.ignoredFilters.length ? { ignoredFilters: res.ignoredFilters } : {}),
        };
      },
    }),
    defineTool({
      name: catalogToolNames.get,
      kind: "read",
      description:
        "Everything about one item: description, details, every option with its exact price, sale price, stock and length. Use it before quoting a price for a specific option.",
      input: z.object({ itemId: z.string().min(3).max(60) }),
      run: async ({ itemId }, ctx) =>
        (await deps.get(itemId, ctx)) ?? { found: false, hint: "No such item here." },
    }),
    defineTool({
      name: catalogToolNames.show,
      kind: "reply",
      description:
        "Show items to the customer: each with its main photo, name and price, and buttons to order or see more. Use it whenever the customer would want to see what you found (1 to 10 items, best first). Ends your turn.",
      input: z.object({
        itemIds: ids.min(1).max(10),
        text: z.string().max(600).optional().describe("A short line to go with them"),
        action: z
          .enum(["order", "book", "none"])
          .default("order")
          .describe("book for services, order for products"),
      }),
    }),
    defineTool({
      name: catalogToolNames.media,
      kind: "reply",
      description:
        "Send all of one item's photos and videos (and any audio or brochure) when the customer wants to see more of it. Ends your turn.",
      input: z.object({
        itemId: z.string().min(3).max(60),
        text: z.string().max(300).optional(),
      }),
    }),
  ];
}

/* ------------------------------------------------------------------ the price guard */

const moneyPattern =
  /(?:(?:AED|INR|SAR|QAR|KWD|OMR|BHD|USD|EUR|GBP|Rs\.?|₹|\$|€|£|د\.إ)\s?(\d[\d,]*(?:\.\d+)?))|(?:(\d[\d,]*(?:\.\d+)?)\s?(?:AED|INR|SAR|QAR|KWD|OMR|BHD|USD|EUR|GBP|dirhams?|rupees?|riyals?|₹|د\.إ))/gi;

/** Money amounts written in a reply ("AED 1,200", "₹499", "250 dirhams"), as numbers. */
export function moneyAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(moneyPattern)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Every number in some JSON or text, normalised ("1,200.50" → 1200.5), to check amounts against. */
export function numbersIn(source: string): Set<number> {
  const out = new Set<number>();
  for (const m of source.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(Math.round(n * 1000) / 1000);
  }
  return out;
}

/** Amounts in `text` that appear nowhere in `known`. */
export function unknownAmounts(text: string, known: Set<number>): number[] {
  return moneyAmounts(text).filter((n) => !known.has(Math.round(n * 1000) / 1000));
}
