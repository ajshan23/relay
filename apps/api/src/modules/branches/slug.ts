import { and, eq, or, schema, sql } from "@relay/db";
import type { AppContext } from "../../context";

/** Lowercase, hyphenated slug from a display name ("Dubai Marina!" -> "dubai-marina"). */
export function slugify(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "branch";
}

/** A slug for the name that no branch in the organization uses yet (archived ones included), adding -2, -3... */
export async function uniqueSlug(ctx: AppContext, orgId: string, name: string) {
  const base = slugify(name);
  const rows = await ctx.db
    .select({ slug: schema.branch.slug })
    .from(schema.branch)
    .where(
      and(
        eq(schema.branch.organizationId, orgId),
        or(eq(schema.branch.slug, base), sql`${schema.branch.slug} like ${`${base}-%`}`),
      ),
    );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
