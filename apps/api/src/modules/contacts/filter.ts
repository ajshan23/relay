import {
  type ContactFieldDef,
  type ContactFilter,
  type FilterRule,
  opsFor,
  type ViewConfig,
} from "@relay/core/contacts";
import { type SQL, schema, sql } from "@relay/db";

/*
 * Compiles the contacts table's filters and sort into SQL. Only whitelisted core columns and the
 * business's own fields (by key, looked up in contact_field) are allowed; every value is a bound
 * parameter. The same compiler picks broadcast audiences later.
 */

export class FilterError extends Error {}

const c = schema.contact;
const utc = (iso: string) => sql`${iso}::timestamptz at time zone 'UTC'`;
const daysAgo = (n: number) => sql`(now() at time zone 'UTC') - make_interval(days => ${n})`;
const like = (v: unknown) => `%${String(v ?? "").replace(/[%_\\]/g, "\\$&")}%`;
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)];
/** A Postgres text[] from strings, as bound parameters (drizzle would otherwise expand a JS array). */
const textArray = (vals: string[]) =>
  vals.length
    ? sql`array[${sql.join(
        vals.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;
const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FilterError("Expected a number.");
  return n;
};
const date = (v: unknown) => {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new FilterError("Expected a date (YYYY-MM-DD).");
  return s.slice(0, 10);
};

/** The phone of any of the contact's channel identities, or its own main phone. */
const phoneMatches = (cond: (col: SQL) => SQL) =>
  sql`(${cond(sql`${c.phone}`)} or exists (select 1 from ${schema.contactIdentity} i where i.contact_id = ${c.id} and ${cond(sql`i.phone`)}))`;

function textRule(expr: SQL, op: string, value: unknown): SQL {
  switch (op) {
    case "contains":
      return sql`${expr} ilike ${like(value)}`;
    case "is":
      return sql`lower(${expr}) = lower(${String(value ?? "")})`;
    case "is_not":
      return sql`(${expr} is null or lower(${expr}) <> lower(${String(value ?? "")}))`;
    case "is_empty":
      return sql`(${expr} is null or ${expr} = '')`;
    case "is_not_empty":
      return sql`(${expr} is not null and ${expr} <> '')`;
  }
  throw new FilterError(`"${op}" doesn't work on text.`);
}

function dateRule(expr: SQL, op: string, value: unknown, isTimestamp: boolean): SQL {
  const at = (v: unknown) => (isTimestamp ? utc(date(v)) : sql`${date(v)}::date`);
  switch (op) {
    case "before":
      return sql`${expr} < ${at(value)}`;
    case "after":
      return isTimestamp ? sql`${expr} >= ${at(value)} + interval '1 day'` : sql`${expr} > ${at(value)}`;
    case "between": {
      const [from, to] = arr(value);
      return isTimestamp
        ? sql`${expr} >= ${at(from)} and ${expr} < ${at(to)} + interval '1 day'`
        : sql`${expr} between ${at(from)} and ${at(to)}`;
    }
    case "in_last_days":
      return isTimestamp
        ? sql`${expr} >= ${daysAgo(num(value))}`
        : sql`${expr} >= (${daysAgo(num(value))})::date`;
    case "is_empty":
      return sql`${expr} is null`;
    case "is_not_empty":
      return sql`${expr} is not null`;
  }
  throw new FilterError(`"${op}" doesn't work on dates.`);
}

function coreRule(rule: FilterRule): SQL {
  const { op, value } = rule;
  switch (rule.field) {
    case "name":
      return textRule(sql`${c.name}`, op, value);
    case "email":
      return textRule(sql`${c.email}`, op, value);
    case "phone": {
      const digits = String(value ?? "").replace(/[^\d]/g, "");
      if (op === "contains") return phoneMatches((col) => sql`${col} like ${`%${digits}%`}`);
      if (op === "is") return phoneMatches((col) => sql`${col} = ${digits}`);
      if (op === "is_empty") return sql`not ${phoneMatches((col) => sql`${col} is not null`)}`;
      if (op === "is_not_empty") return phoneMatches((col) => sql`${col} is not null`);
      throw new FilterError(`"${op}" doesn't work on phone numbers.`);
    }
    case "tags": {
      const ids = arr(value);
      if (op === "has_any") return sql`${c.tagIds} && ${textArray(ids)}`;
      if (op === "has_all") return sql`${c.tagIds} @> ${textArray(ids)}`;
      if (op === "has_none") return sql`not (${c.tagIds} && ${textArray(ids)})`;
      if (op === "is_empty") return sql`cardinality(${c.tagIds}) = 0`;
      throw new FilterError(`"${op}" doesn't work on tags.`);
    }
    case "branch": {
      if (op === "is_any_of") return sql`${c.branchId} = any(${textArray(arr(value))})`;
      if (op === "is_empty") return sql`${c.branchId} is null`;
      throw new FilterError(`"${op}" doesn't work on branches.`);
    }
    case "lastMessageAt":
      return dateRule(sql`${c.lastMessageAt}`, op, value, true);
    case "createdAt":
      return dateRule(sql`${c.createdAt}`, op, value, true);
    case "marketing":
      if (op === "is_true") return sql`${c.marketingOptOutAt} is null`;
      if (op === "is_false") return sql`${c.marketingOptOutAt} is not null`;
      throw new FilterError(`"${op}" doesn't work on marketing.`);
  }
  throw new FilterError(`Unknown column "${rule.field}".`);
}

function fieldRule(field: ContactFieldDef, op: string, value: unknown): SQL {
  if (!(opsFor[field.type] ?? []).includes(op as never))
    throw new FilterError(`"${op}" doesn't work on ${field.label}.`);
  const key = field.key;
  const raw = sql`(${c.attributes} ->> ${key})`;
  const has = (obj: Record<string, unknown>) => sql`${c.attributes} @> ${JSON.stringify(obj)}::jsonb`;
  switch (field.type) {
    case "text":
    case "email":
    case "phone":
    case "url":
      return textRule(raw, op, value);
    case "number": {
      const n = sql`relay_attr_num(${c.attributes}, ${key})`;
      if (op === "eq") return sql`${n} = ${num(value)}`;
      if (op === "lt") return sql`${n} < ${num(value)}`;
      if (op === "gt") return sql`${n} > ${num(value)}`;
      if (op === "between") {
        const [a, b] = arr(value);
        return sql`${n} between ${num(a)} and ${num(b)}`;
      }
      return op === "is_empty" ? sql`${n} is null` : sql`${n} is not null`;
    }
    case "date":
      return dateRule(sql`relay_attr_date(${c.attributes}, ${key})`, op, value, false);
    case "boolean":
      if (op === "is_true") return has({ [key]: true });
      if (op === "is_false") return has({ [key]: false });
      return sql`not (${c.attributes} ? ${key})`;
    case "select": {
      if (op === "is_any_of") {
        const vals = arr(value);
        if (!vals.length) return sql`false`;
        return sql`(${sql.join(
          vals.map((v) => has({ [key]: v })),
          sql` or `,
        )})`;
      }
      return op === "is_empty" ? sql`${raw} is null` : sql`${raw} is not null`;
    }
    case "multi_select": {
      const vals = arr(value);
      const list = sql`(${c.attributes} -> ${key})`;
      if (op === "has_any") return sql`${list} ?| ${textArray(vals)}`;
      if (op === "has_all") return has({ [key]: vals });
      if (op === "has_none") return sql`not coalesce(${list} ?| ${textArray(vals)}, false)`;
      return sql`coalesce(jsonb_array_length(${list}), 0) = 0`;
    }
  }
}

/** WHERE clause for a filter. `fields` are the business's active fields, by key. */
export function compileFilter(
  filter: ContactFilter | undefined,
  fields: Map<string, ContactFieldDef>,
): SQL | undefined {
  if (!filter?.rules.length) return undefined;
  const parts = filter.rules.map((rule) => {
    if (rule.field.startsWith("attr.")) {
      const field = fields.get(rule.field.slice(5));
      if (!field) throw new FilterError(`Unknown field "${rule.field.slice(5)}".`);
      return fieldRule(field, rule.op, rule.value);
    }
    return coreRule(rule);
  });
  return sql`(${sql.join(parts, filter.match === "any" ? sql` or ` : sql` and `)})`;
}

/** ORDER BY for a sort, with id as the tie-breaker so pages never repeat or skip rows. */
export function compileSort(sort: ViewConfig["sort"], fields: Map<string, ContactFieldDef>): SQL {
  const dir = sort?.dir === "asc" ? sql`asc` : sql`desc`;
  const nulls = sql`nulls last`;
  let expr: SQL;
  const f = sort?.field ?? "lastMessageAt";
  if (f.startsWith("attr.")) {
    const field = fields.get(f.slice(5));
    if (!field) throw new FilterError(`Unknown field "${f.slice(5)}".`);
    expr =
      field.type === "number"
        ? sql`relay_attr_num(${c.attributes}, ${field.key})`
        : field.type === "date"
          ? sql`relay_attr_date(${c.attributes}, ${field.key})`
          : field.type === "boolean"
            ? sql`(${c.attributes} -> ${field.key})`
            : sql`lower(${c.attributes} ->> ${field.key})`;
  } else {
    const columns: Record<string, SQL> = {
      name: sql`lower(${c.name})`,
      email: sql`lower(${c.email})`,
      phone: sql`${c.phone}`,
      lastMessageAt: sql`${c.lastMessageAt}`,
      createdAt: sql`${c.createdAt}`,
      branch: sql`${c.branchId}`,
      marketing: sql`${c.marketingOptOutAt}`,
      tags: sql`cardinality(${c.tagIds})`,
    };
    const col = columns[f];
    if (!col) throw new FilterError(`Can't sort by "${f}".`);
    expr = col;
  }
  return sql`${expr} ${dir} ${nulls}, ${c.id} ${dir}`;
}
