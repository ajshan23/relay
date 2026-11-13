/*
 * Contacts: the pieces shared by the API (validation, filter compiling) and the browser (table, editors,
 * filter bar). Pure code; import from "@relay/core/contacts".
 *
 * Fixed columns are real columns on `contact`; the business's own fields live in contact.attributes,
 * keyed by field key, stored in their real JSON types.
 */

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "select"
  | "multi_select"
  | "email"
  | "phone"
  | "url";

export const fieldTypes: Record<FieldType, { label: string; hint: string }> = {
  text: { label: "Text", hint: "Any words, like a company or a note." },
  number: { label: "Number", hint: "Amounts, counts, scores." },
  date: { label: "Date", hint: "Birthdays, renewal dates." },
  boolean: { label: "Yes / No", hint: "A tick box." },
  select: { label: "Single choice", hint: "One option from a list." },
  multi_select: { label: "Multiple choice", hint: "Several options from a list." },
  email: { label: "Email", hint: "An email address." },
  phone: { label: "Phone", hint: "A phone number with country code." },
  url: { label: "Link", hint: "A web address." },
};

export type FieldOption = { value: string; label: string; colour: string };

export type ContactFieldDef = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  position: number;
};

export const optionColours = ["gray", "violet", "blue", "green", "amber", "red", "pink", "teal"] as const;

/** "Date of birth!" → "date_of_birth". */
export function fieldKey(label: string) {
  return (
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field"
  );
}

/**
 * Turns user input into the stored value for a field, or explains why it can't.
 * `null` (or an empty string) clears the value.
 */
export function coerceFieldValue(
  field: Pick<ContactFieldDef, "type" | "options" | "label">,
  input: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (input === null || input === undefined || input === "") return { ok: true, value: null };
  const bad = (message: string) => ({ ok: false as const, message: `${field.label}: ${message}` });
  const text = typeof input === "string" ? input.trim() : input;
  switch (field.type) {
    case "text":
      return typeof text === "string" || typeof text === "number"
        ? { ok: true, value: String(text).slice(0, 2000) }
        : bad("expected text.");
    case "number": {
      const n = typeof text === "number" ? text : Number(String(text).replace(/[, ]/g, ""));
      return Number.isFinite(n) ? { ok: true, value: n } : bad("expected a number.");
    }
    case "date": {
      if (input instanceof Date && !Number.isNaN(input.getTime()))
        return { ok: true, value: input.toISOString().slice(0, 10) };
      const s = String(text);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return { ok: true, value: s };
      const d = new Date(s);
      return Number.isNaN(d.getTime())
        ? bad("expected a date (YYYY-MM-DD).")
        : { ok: true, value: d.toISOString().slice(0, 10) };
    }
    case "boolean": {
      if (typeof text === "boolean") return { ok: true, value: text };
      const s = String(text).toLowerCase();
      if (["yes", "y", "true", "1"].includes(s)) return { ok: true, value: true };
      if (["no", "n", "false", "0"].includes(s)) return { ok: true, value: false };
      return bad("expected yes or no.");
    }
    case "select": {
      const s = String(text);
      const o = field.options.find((x) => x.value === s || x.label.toLowerCase() === s.toLowerCase());
      return o ? { ok: true, value: o.value } : bad(`"${s}" isn't one of the options.`);
    }
    case "multi_select": {
      const parts = Array.isArray(text)
        ? text.map(String)
        : String(text)
            .split(/[,;]/)
            .map((x) => x.trim())
            .filter(Boolean);
      const values: string[] = [];
      for (const p of parts) {
        const o = field.options.find((x) => x.value === p || x.label.toLowerCase() === p.toLowerCase());
        if (!o) return bad(`"${p}" isn't one of the options.`);
        if (!values.includes(o.value)) values.push(o.value);
      }
      return { ok: true, value: values };
    }
    case "email": {
      const s = String(text).toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
        ? { ok: true, value: s }
        : bad("expected an email address.");
    }
    case "phone": {
      const s = String(text).replace(/[^\d+]/g, "");
      return /^\+?\d{6,16}$/.test(s) ? { ok: true, value: s } : bad("expected a phone number.");
    }
    case "url": {
      const s = String(text);
      const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
      try {
        new URL(withScheme);
        return { ok: true, value: withScheme };
      } catch {
        return bad("expected a web address.");
      }
    }
  }
}

/* ------------------------------------------------------------------ filters */

/** Fixed columns, as the table and the filter bar know them. */
export const coreColumns = {
  name: { label: "Name", type: "text" },
  phone: { label: "Phone", type: "phone" },
  email: { label: "Email", type: "email" },
  tags: { label: "Tags", type: "tags" },
  branch: { label: "Branch", type: "branch" },
  lastMessageAt: { label: "Last message", type: "date" },
  createdAt: { label: "Added on", type: "date" },
  marketing: { label: "Marketing", type: "marketing" },
} as const;

export type CoreColumn = keyof typeof coreColumns;

export type FilterOp =
  | "is"
  | "is_not"
  | "contains"
  | "is_empty"
  | "is_not_empty"
  | "eq"
  | "lt"
  | "gt"
  | "between"
  | "before"
  | "after"
  | "in_last_days"
  | "is_any_of"
  | "has_any"
  | "has_all"
  | "has_none"
  | "is_true"
  | "is_false";

/** `field` is a core column name, or `attr.<key>` for one of the business's fields. */
export type FilterRule = { field: string; op: FilterOp; value?: unknown };
export type ContactFilter = { match: "all" | "any"; rules: FilterRule[] };

/** Which operators make sense for each kind of column. */
export const opsFor: Record<string, FilterOp[]> = {
  text: ["contains", "is", "is_not", "is_empty", "is_not_empty"],
  email: ["contains", "is", "is_empty", "is_not_empty"],
  phone: ["contains", "is", "is_empty", "is_not_empty"],
  url: ["contains", "is_empty", "is_not_empty"],
  number: ["eq", "lt", "gt", "between", "is_empty", "is_not_empty"],
  date: ["before", "after", "between", "in_last_days", "is_empty", "is_not_empty"],
  boolean: ["is_true", "is_false", "is_empty"],
  select: ["is_any_of", "is_empty", "is_not_empty"],
  multi_select: ["has_any", "has_all", "has_none", "is_empty"],
  tags: ["has_any", "has_all", "has_none", "is_empty"],
  branch: ["is_any_of", "is_empty"],
  marketing: ["is_true", "is_false"],
};

export const opLabels: Record<FilterOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  eq: "equals",
  lt: "is less than",
  gt: "is more than",
  between: "is between",
  before: "is before",
  after: "is after",
  in_last_days: "in the last",
  is_any_of: "is any of",
  has_any: "has any of",
  has_all: "has all of",
  has_none: "has none of",
  is_true: "is yes",
  is_false: "is no",
};

/** A table view: which columns show, in what order and width, plus filters and sort. */
export type ViewConfig = {
  columns: { id: string; width?: number; hidden?: boolean }[];
  filter: ContactFilter;
  sort: { field: string; dir: "asc" | "desc" } | null;
};

export const defaultView: ViewConfig = {
  columns: [
    { id: "name" },
    { id: "phone" },
    { id: "tags" },
    { id: "branch" },
    { id: "lastMessageAt" },
    { id: "createdAt" },
    { id: "marketing" },
  ],
  filter: { match: "all", rules: [] },
  sort: { field: "lastMessageAt", dir: "desc" },
};
