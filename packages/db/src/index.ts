// Query helpers are re-exported so every package uses this package's copy of drizzle-orm.
// Importing them from "drizzle-orm" directly elsewhere can resolve to a second copy with clashing types.

export type { AnyColumn } from "drizzle-orm";
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
export * from "./client";
export * as schema from "./schema/index";
