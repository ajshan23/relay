"use client";

import type { ContactFieldDef } from "@relay/core/contacts";
import { Icon } from "@relay/ui/components/icon";
import { TextInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import { Checkbox } from "@relay/ui/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@relay/ui/ui/popover";
import { Switch } from "@relay/ui/ui/switch";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import type { Tag } from "./queries";

/** Soft chip colours, readable in light and dark. */
export const chipColour: Record<string, string> = {
  gray: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  red: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
};

export function Chip({
  colour,
  children,
  className,
}: {
  colour?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-40 items-center truncate rounded-md px-1.5 text-xs font-medium",
        chipColour[colour ?? "gray"] ?? chipColour.gray,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function TagChips({ ids, tags }: { ids: string[]; tags: Tag[] }) {
  const list = ids.map((id) => tags.find((t) => t.id === id)).filter((t): t is Tag => !!t);
  if (!list.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex gap-1 overflow-hidden">
      {list.map((t) => (
        <Chip key={t.id} colour={t.colour}>
          {t.name}
        </Chip>
      ))}
    </span>
  );
}

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A field's value as text and chips, the way the table shows it. */
export function FieldValue({ field, value }: { field: ContactFieldDef; value: unknown }) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length))
    return <span className="text-muted-foreground">—</span>;
  switch (field.type) {
    case "boolean":
      return value ? (
        <span className="inline-flex items-center gap-1 text-foreground">
          <Icon name="check" size="xs" /> Yes
        </span>
      ) : (
        <span className="text-muted-foreground">No</span>
      );
    case "date": {
      const d = new Date(`${String(value)}T00:00:00`);
      return <span>{Number.isNaN(d.getTime()) ? String(value) : dateFmt.format(d)}</span>;
    }
    case "number":
      return <span className="tabular-nums">{Number(value).toLocaleString()}</span>;
    case "select": {
      const o = field.options.find((x) => x.value === value);
      return <Chip colour={o?.colour}>{o?.label ?? String(value)}</Chip>;
    }
    case "multi_select":
      return (
        <span className="flex gap-1 overflow-hidden">
          {(value as string[]).map((v) => {
            const o = field.options.find((x) => x.value === v);
            return (
              <Chip key={v} colour={o?.colour}>
                {o?.label ?? v}
              </Chip>
            );
          })}
        </span>
      );
    case "url":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-primary underline-offset-2 hover:underline"
        >
          {String(value).replace(/^https?:\/\//, "")}
        </a>
      );
    case "phone":
      return <span className="tabular-nums">+{String(value).replace(/^\+/, "")}</span>;
    default:
      return <span className="truncate">{String(value)}</span>;
  }
}

/** The editor for one value of one field. Calls onSave with the new value (null clears it). */
export function FieldEditor({
  field,
  value,
  onSave,
}: {
  field: ContactFieldDef;
  value: unknown;
  onSave: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState<string>(
    value === null || value === undefined ? "" : Array.isArray(value) ? "" : String(value),
  );
  if (field.type === "boolean")
    return (
      <label className="flex items-center justify-between gap-3 text-sm">
        {field.label}
        <Switch checked={value === true} onCheckedChange={(v) => onSave(v)} />
      </label>
    );
  if (field.type === "select")
    return (
      <div className="flex flex-col gap-0.5">
        {field.options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onSave(o.value)}
            className="flex items-center justify-between rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted"
          >
            <Chip colour={o.colour}>{o.label}</Chip>
            {value === o.value ? <Icon name="check" size="sm" /> : null}
          </button>
        ))}
        {value ? (
          <Button variant="ghost" size="sm" className="mt-1 justify-start" onClick={() => onSave(null)}>
            Clear
          </Button>
        ) : null}
      </div>
    );
  if (field.type === "multi_select") {
    const current = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex flex-col gap-0.5">
        {field.options.map((o) => {
          const on = current.includes(o.value);
          return (
            <label key={o.value} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
              <Checkbox
                checked={on}
                onCheckedChange={(v) =>
                  onSave(v ? [...current, o.value] : current.filter((x) => x !== o.value))
                }
              />
              <Chip colour={o.colour}>{o.label}</Chip>
            </label>
          );
        })}
      </div>
    );
  }
  const inputType =
    field.type === "number"
      ? "number"
      : field.type === "date"
        ? "date"
        : field.type === "email"
          ? "email"
          : "text";
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft.trim() === "" ? null : field.type === "number" ? Number(draft) : draft.trim());
      }}
    >
      <TextInput
        autoFocus
        type={inputType}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={field.label}
        placeholder={
          field.type === "phone" ? "+971 50 123 4567" : field.type === "url" ? "example.com" : undefined
        }
      />
      <div className="flex justify-end gap-2">
        {value !== null && value !== undefined && value !== "" ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onSave(null)}>
            Clear
          </Button>
        ) : null}
        <Button type="submit" size="sm">
          Save
        </Button>
      </div>
    </form>
  );
}

/** A table cell that opens an editor on click, for people who can edit. */
export function EditableCell({
  canEdit,
  display,
  editor,
  label,
}: {
  canEdit: boolean;
  display: ReactNode;
  editor: (close: () => void) => ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  if (!canEdit) return <>{display}</>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Edit ${label}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="-mx-1.5 flex h-8 w-[calc(100%+0.75rem)] min-w-0 items-center rounded-md px-1.5 text-left outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {display}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" onClick={(e) => e.stopPropagation()}>
        {editor(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}
