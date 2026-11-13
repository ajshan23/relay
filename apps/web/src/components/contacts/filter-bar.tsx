"use client";

import {
  type ContactFilter,
  coreColumns,
  type FilterOp,
  type FilterRule,
  opLabels,
  opsFor,
} from "@relay/core/contacts";
import { Icon } from "@relay/ui/components/icon";
import { TextInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import { Checkbox } from "@relay/ui/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@relay/ui/ui/popover";
import { useState } from "react";
import { Chip } from "./cells";
import type { ContactsMeta } from "./queries";

type Column = {
  id: string;
  label: string;
  kind: string;
  options?: { value: string; label: string; colour?: string }[];
};

/** Everything that can be filtered: fixed columns, then the business's fields. */
export function filterColumns(meta: ContactsMeta): Column[] {
  const core: Column[] = (Object.keys(coreColumns) as (keyof typeof coreColumns)[]).map((id) => ({
    id,
    label: coreColumns[id].label,
    kind: coreColumns[id].type,
    options:
      id === "tags"
        ? meta.tags.map((t) => ({ value: t.id, label: t.name, colour: t.colour }))
        : id === "branch"
          ? meta.branches.map((b) => ({ value: b.id, label: b.name }))
          : undefined,
  }));
  const own: Column[] = meta.fields.map((f) => ({
    id: `attr.${f.key}`,
    label: f.label,
    kind: f.type,
    options: f.options,
  }));
  return [...core, ...own];
}

const noValue: FilterOp[] = ["is_empty", "is_not_empty", "is_true", "is_false"];

function describe(rule: FilterRule, col: Column | undefined) {
  const label = col?.label ?? rule.field;
  if (rule.field === "marketing")
    return rule.op === "is_true" ? "Subscribed to marketing" : "Opted out of marketing";
  if (noValue.includes(rule.op)) return `${label} ${opLabels[rule.op]}`;
  const v = rule.value;
  const named = (x: unknown) => col?.options?.find((o) => o.value === x)?.label ?? String(x);
  const text = Array.isArray(v)
    ? rule.op === "between"
      ? `${v[0]} and ${v[1]}`
      : v.map(named).join(", ")
    : rule.op === "in_last_days"
      ? `${v} days`
      : named(v);
  return `${label} ${opLabels[rule.op]} ${text}`;
}

/** The value input for one rule, chosen by the column's kind and the operator. */
function ValueInput({
  col,
  op,
  value,
  onChange,
}: {
  col: Column;
  op: FilterOp;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (noValue.includes(op)) return null;
  if (col.options && ["is_any_of", "has_any", "has_all", "has_none"].includes(op)) {
    const current = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
        {col.options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted">
            <Checkbox
              checked={current.includes(o.value)}
              onCheckedChange={(v) =>
                onChange(v ? [...current, o.value] : current.filter((x) => x !== o.value))
              }
            />
            <Chip colour={o.colour}>{o.label}</Chip>
          </label>
        ))}
        {!col.options.length ? (
          <p className="px-1.5 text-xs text-muted-foreground">Nothing to pick yet.</p>
        ) : null}
      </div>
    );
  }
  const type =
    col.kind === "date"
      ? op === "in_last_days"
        ? "number"
        : "date"
      : col.kind === "number"
        ? "number"
        : "text";
  if (op === "between") {
    const [a, b] = Array.isArray(value) ? (value as string[]) : ["", ""];
    return (
      <div className="flex items-center gap-2">
        <TextInput
          size="sm"
          type={type}
          value={a ?? ""}
          onChange={(e) => onChange([e.target.value, b])}
          aria-label="From"
        />
        <span className="text-xs text-muted-foreground">and</span>
        <TextInput
          size="sm"
          type={type}
          value={b ?? ""}
          onChange={(e) => onChange([a, e.target.value])}
          aria-label="To"
        />
      </div>
    );
  }
  return (
    <TextInput
      size="sm"
      autoFocus
      type={type}
      value={(value as string) ?? ""}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Value"
      trailing={
        op === "in_last_days" ? <span className="text-xs text-muted-foreground">days</span> : undefined
      }
    />
  );
}

function RuleEditor({
  columns,
  initial,
  onDone,
}: {
  columns: Column[];
  initial?: FilterRule;
  onDone: (rule: FilterRule | null) => void;
}) {
  const [field, setField] = useState(initial?.field ?? "");
  const col = columns.find((c) => c.id === field);
  const ops = col ? (opsFor[col.kind] ?? []) : [];
  const [op, setOp] = useState<FilterOp | "">(initial?.op ?? "");
  const [value, setValue] = useState<unknown>(initial?.value);

  if (!col)
    return (
      <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        <p className="px-2 pb-1 text-xs text-muted-foreground">Filter by</p>
        {columns.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              setField(c.id);
              setOp(opsFor[c.kind]?.[0] ?? "");
              setValue(undefined);
            }}
            className="rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted"
          >
            {c.label}
          </button>
        ))}
      </div>
    );

  const ready =
    op &&
    (noValue.includes(op) ||
      (value !== undefined && value !== "" && !(Array.isArray(value) && !value.length)));
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm font-medium">{col.label}</p>
      <div className="flex flex-wrap gap-1">
        {ops.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={op === o}
            onClick={() => setOp(o)}
            className={`rounded-md border px-2 py-0.5 text-xs outline-none ${op === o ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}
          >
            {opLabels[o]}
          </button>
        ))}
      </div>
      {op ? <ValueInput col={col} op={op} value={value} onChange={setValue} /> : null}
      <div className="flex justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => (initial ? onDone(null) : setField(""))}>
          {initial ? "Remove" : "Back"}
        </Button>
        <Button size="sm" disabled={!ready} onClick={() => op && onDone({ field, op, value })}>
          Apply
        </Button>
      </div>
    </div>
  );
}

export function FilterBar({
  meta,
  filter,
  onChange,
}: {
  meta: ContactsMeta;
  filter: ContactFilter;
  onChange: (f: ContactFilter) => void;
}) {
  const columns = filterColumns(meta);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const setRules = (rules: FilterRule[]) => onChange({ ...filter, rules });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filter.rules.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rules are edited by position
        <div key={i} className="inline-flex h-7 items-center rounded-md border bg-card text-xs">
          <Popover open={editing === i} onOpenChange={(o) => setEditing(o ? i : null)}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="h-full rounded-l-md pr-1 pl-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {describe(
                  r,
                  columns.find((c) => c.id === r.field),
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-3">
              <RuleEditor
                columns={columns}
                initial={r}
                onDone={(rule) => {
                  setRules(
                    rule
                      ? filter.rules.map((x, j) => (j === i ? rule : x))
                      : filter.rules.filter((_, j) => j !== i),
                  );
                  setEditing(null);
                }}
              />
            </PopoverContent>
          </Popover>
          <button
            type="button"
            aria-label="Remove filter"
            onClick={() => setRules(filter.rules.filter((_, j) => j !== i))}
            className="flex h-full items-center rounded-r-md px-1.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Icon name="close" size="xs" />
          </button>
        </div>
      ))}
      {filter.rules.length > 1 ? (
        <button
          type="button"
          onClick={() => onChange({ ...filter, match: filter.match === "all" ? "any" : "all" })}
          className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted"
        >
          Match {filter.match === "all" ? "all" : "any"}
        </button>
      ) : null}
      <Popover open={adding} onOpenChange={setAdding}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <Icon name="filter" />
            Filter
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          <RuleEditor
            columns={columns}
            onDone={(rule) => {
              if (rule) setRules([...filter.rules, rule]);
              setAdding(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {filter.rules.length ? (
        <Button variant="ghost" size="sm" onClick={() => setRules([])}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}
