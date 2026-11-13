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
/** contact.id spelled out: inside a subquery a bare "id" would mean the subquery's own row. */
const contactId = sql.raw('"contact"."id"');
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
  sql`(${cond(sql`${c.phone}`)} or exists (select 1 from ${schema.contactIdentity} i where i.contact_id = ${contactId} and ${cond(sql`i.phone`)}))`;

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

function coreRule(rule: FilterRule, scope: Scope): SQL {
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
    case "marketing": {
      const any = sql`exists (select 1 from ${schema.contactOptOut} o where o.contact_id = ${contactId})`;
      // Opted out on one of these channels, or on every channel.
      const on = (ids: string[]) =>
        sql`exists (select 1 from ${schema.contactOptOut} o where o.contact_id = ${contactId} and (o.channel_account_id is null or o.channel_account_id = any(${textArray(ids)})))`;
      if (op === "is_true") return sql`not ${any}`;
      if (op === "is_false") return any;
      if (op === "has_any") return on(arr(value));
      if (op === "has_none") return sql`not ${on(arr(value))}`;
      throw new FilterError(`"${op}" doesn't work on marketing.`);
    }
    case "list": {
      const ids = arr(value);
      if (!ids.length) throw new FilterError("Pick a list.");
      const inAny = sql`(${sql.join(
        ids.map((id) => inList(id, scope)),
        sql` or `,
      )})`;
      if (op === "has_any") return inAny;
      if (op === "has_none") return sql`not ${inAny}`;
      throw new FilterError(`"${op}" doesn't work on lists.`);
    }
  }
  throw new FilterError(`Unknown column "${rule.field}".`);
}

/** The lists a filter may refer to, by id: static lists by membership, smart lists by their own filter. */
export type ListsById = Map<string, { kind: "static" | "smart"; filter: unknown }>;

type Scope = { fields: Map<string, ContactFieldDef>; lists: ListsById; depth: number };

function inList(id: string, { fields, lists, depth }: Scope): SQL {
  const list = lists.get(id);
  if (!list) throw new FilterError("That list doesn't exist.");
  if (list.kind === "static")
    return sql`exists (select 1 from ${schema.contactListMember} m where m.contact_id = ${contactId} and m.list_id = ${id})`;
  // A smart list is its saved filter. One level only, so lists can't refer to each other in a loop.
  if (depth > 0) throw new FilterError("A smart list can't use another smart list.");
  return compileFilter(list.filter as ContactFilter, fields, lists, depth + 1) ?? sql`true`;
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
  lists: ListsById = new Map(),
  depth = 0,
): SQL | undefined {
  if (!filter?.rules.length) return undefined;
  const parts = filter.rules.map((rule) => {
    if (rule.field.startsWith("attr.")) {
      const field = fields.get(rule.field.slice(5));
      if (!field) throw new FilterError(`Unknown field "${rule.field.slice(5)}".`);
      return fieldRule(field, rule.op, rule.value);
    }
    return coreRule(rule, { fields, lists, depth });
  });
  return sql`(${sql.join(parts, filter.match === "any" ? sql` or ` : sql` and `)})`;
}

/** The expression a sort orders by, its SQL type and its direction. */
function sortKey(sort: ViewConfig["sort"], fields: Map<string, ContactFieldDef>) {
  const f = sort?.field ?? "lastMessageAt";
  const asc = sort?.dir === "asc";
  if (f.startsWith("attr.")) {
    const field = fields.get(f.slice(5));
    if (!field) throw new FilterError(`Unknown field "${f.slice(5)}".`);
    if (field.type === "number")
      return { expr: sql`relay_attr_num(${c.attributes}, ${field.key})`, type: "numeric", asc };
    if (field.type === "date")
      return { expr: sql`relay_attr_date(${c.attributes}, ${field.key})`, type: "date", asc };
    if (field.type === "boolean") return { expr: sql`(${c.attributes} -> ${field.key})`, type: "jsonb", asc };
    return { expr: sql`lower(${c.attributes} ->> ${field.key})`, type: "text", asc };
  }
  const columns: Record<string, [SQL, string]> = {
    name: [sql`lower(${c.name})`, "text"],
    email: [sql`lower(${c.email})`, "text"],
    phone: [sql`${c.phone}`, "text"],
    lastMessageAt: [sql`${c.lastMessageAt}`, "timestamp"],
    createdAt: [sql`${c.createdAt}`, "timestamp"],
    branch: [sql`${c.branchId}`, "text"],
    marketing: [
      sql`(select count(*) from ${schema.contactOptOut} o where o.contact_id = ${contactId})`,
      "bigint",
    ],
    tags: [sql`cardinality(${c.tagIds})`, "int"],
  };
  const col = columns[f];
  if (!col) throw new FilterError(`Can't sort by "${f}".`);
  return { expr: col[0], type: col[1], asc };
}

/**
 * ORDER BY for a sort, with id as the tie-breaker so pages never repeat or skip rows. Empty values go
 * last either way. Newest-first matches the (branch, last message / added on, id) indexes.
 */
export function compileSort(sort: ViewConfig["sort"], fields: Map<string, ContactFieldDef>): SQL {
  const { expr, asc } = sortKey(sort, fields);
  const dir = asc ? sql`asc` : sql`desc`;
  return sql`${expr} ${dir} nulls last, ${contactId} ${dir} nulls last`;
}

/**
 * Keyset paging: the rows after a given contact in the sort order, so page 400 costs what page 2 does.
 * `key` is the sort value as text, read from the cursor's row. With it, `after(value)` is the WHERE for the
 * rest of the rows that have a value, and `nulls` the WHERE for the empty ones that follow them (empty
 * values sort last, and a row comparison can't reach them, so they're a second, separate range).
 */
export function compileKeyset(sort: ViewConfig["sort"], fields: Map<string, ContactFieldDef>) {
  const { expr, type, asc } = sortKey(sort, fields);
  const beyond = asc ? sql`>` : sql`<`;
  const cast = sql.raw(type);
  return {
    /** The sort value as text, to read from the cursor's row. */
    key: sql<string | null>`(${expr})::text`,
    after: (value: string, afterId: string) =>
      sql`(${expr}, ${contactId}) ${beyond} (${value}::${cast}, ${afterId})`,
    nulls: (afterId?: string) =>
      afterId ? sql`(${expr} is null and ${contactId} ${beyond} ${afterId})` : sql`${expr} is null`,
    nullsOrder: asc ? sql`${contactId} asc` : sql`${contactId} desc nulls last`,
  };
}
