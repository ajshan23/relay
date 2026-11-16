"use client";

import { type AutomationDefinition, type UtilityConfig, utilityDef } from "@relay/core/automations";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@relay/ui/ui/select";
import type { EditorOptions } from "./queries";

/*
 * Everything a step can read by name: answers (and a shared location's parts), what Utility steps
 * worked out (and their parts), the contact's details, and the message that started the run. Used by
 * the "Insert detail" menu, the value and date rules, and the utilities' inputs, so they all list the
 * same things the same way.
 */

export type ValueKind = "text" | "number" | "date" | "location";
export type SavedValue = { path: string; label: string; group: SavedGroup; kind: ValueKind };
export type SavedGroup = "Answers" | "Worked out" | "Contact" | "Message" | "Other";
export const savedGroups: SavedGroup[] = ["Answers", "Worked out", "Contact", "Message", "Other"];

const locationParts: [string, string, ValueKind][] = [
  ["map_link", "map link", "text"],
  ["latitude", "latitude", "number"],
  ["longitude", "longitude", "number"],
  ["name", "place name", "text"],
  ["address", "address", "text"],
];

/** What a utility's parts hold, for the pickers ("km" is a number, "date" a date). */
const partKinds: Record<string, ValueKind> = {
  km: "number",
  miles: "number",
  meters: "number",
  number: "number",
  days: "number",
  weeks: "number",
  months: "number",
  years: "number",
  day: "number",
  year: "number",
  hour: "number",
  count: "number",
  date: "date",
};

export function savedValues(def: AutomationDefinition, options?: EditorOptions): SavedValue[] {
  const out: SavedValue[] = [];
  for (const n of def.nodes) {
    const c = n.config as Record<string, unknown>;
    const name = typeof c.saveAs === "string" ? c.saveAs : "";
    if (!name) continue;
    if (n.type === "ask_location") {
      out.push({ path: `answers.${name}`, label: name, group: "Answers", kind: "location" });
      for (const [part, words, kind] of locationParts)
        out.push({ path: `answers.${name}.${part}`, label: `${name}: ${words}`, group: "Answers", kind });
    } else if (n.type === "ask_question" || c.waitForReply) {
      const format = (c.answer as { format?: string } | undefined)?.format;
      out.push({
        path: `answers.${name}`,
        label: name,
        group: "Answers",
        kind: format === "date" ? "date" : format === "number" ? "number" : "text",
      });
    } else if (n.type === "utility") {
      const u = c as UtilityConfig;
      const d = utilityDef(String(u.fn));
      const kind: ValueKind = u.fn === "date_time" ? "date" : u.fn === "calculate" ? "number" : "text";
      out.push({ path: `values.${name}`, label: name, group: "Worked out", kind });
      for (const part of d?.parts ?? [])
        out.push({
          path: `values.${name}.${part}`,
          label: `${name}: ${part.replace(/_/g, " ")}`,
          group: "Worked out",
          kind: partKinds[part] ?? "text",
        });
    }
  }
  // One entry per path (a name saved by two steps).
  const seen = new Set<string>();
  const unique = out.filter((v) => {
    if (seen.has(v.path)) return false;
    seen.add(v.path);
    return true;
  });
  const contact: SavedValue[] = [
    { path: "contact.first_name", label: "First name", group: "Contact", kind: "text" },
    { path: "contact.name", label: "Name", group: "Contact", kind: "text" },
    { path: "contact.phone", label: "Phone", group: "Contact", kind: "text" },
    { path: "contact.email", label: "Email", group: "Contact", kind: "text" },
    { path: "contact.added_on", label: "Added on", group: "Contact", kind: "date" },
    ...(options?.fields ?? []).map(
      (f): SavedValue => ({
        path: `contact.${f.key}`,
        label: f.label,
        group: "Contact",
        kind: f.type === "date" ? "date" : f.type === "number" ? "number" : "text",
      }),
    ),
  ];
  return [
    ...unique,
    ...contact,
    { path: "trigger.text", label: "Message that started it", group: "Message", kind: "text" },
    { path: "business.name", label: "Business name", group: "Other", kind: "text" },
    { path: "chat.assignee", label: "Assigned team member", group: "Other", kind: "text" },
  ];
}

/**
 * Pick a saved value by name. `kinds` narrows the list (a distance needs a shared location); `extra`
 * adds choices at the top (like "Today").
 */
export function ValuePicker({
  value,
  onChange,
  def,
  options,
  kinds,
  extra = [],
  placeholder = "Pick a value",
  size = "sm",
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (path: string) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
  kinds?: ValueKind[];
  extra?: { value: string; label: string }[];
  placeholder?: string;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  const all = savedValues(def, options).filter((v) => !kinds || kinds.includes(v.kind));
  const groups = savedGroups
    .map((g) => ({ group: g, items: all.filter((v) => v.group === g) }))
    .filter((g) => g.items.length);
  const known = extra.some((e) => e.value === value) || all.some((v) => v.path === value);
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger size={size === "sm" ? "sm" : "default"} className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {extra.length ? (
          <SelectGroup>
            {extra.map((e) => (
              <SelectItem key={e.value} value={e.value}>
                {e.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {groups.map((g, i) => (
          <SelectGroup key={g.group}>
            {i > 0 || extra.length ? <SelectSeparator /> : null}
            <SelectLabel>{g.group}</SelectLabel>
            {g.items.map((v) => (
              <SelectItem key={v.path} value={v.path}>
                {v.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {value && !known ? (
          // Saved earlier but no longer offered (the step that saved it is gone): keep it visible.
          <SelectGroup>
            <SelectSeparator />
            <SelectItem value={value}>{`{{${value}}}`}</SelectItem>
          </SelectGroup>
        ) : null}
        {!groups.length && !extra.length ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Nothing saved that fits yet.</p>
        ) : null}
      </SelectContent>
    </Select>
  );
}
