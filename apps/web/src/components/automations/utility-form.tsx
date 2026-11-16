"use client";

import {
  type AutomationDefinition,
  currencies,
  type UtilityConfig,
  type UtilityFn,
  utilityDef,
  utilityDefaults,
  utilityFunctions,
} from "@relay/core/automations";
import { Segmented } from "@relay/ui/components/choice";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import { useState } from "react";
import { type ChosenLocation, LocationPicker } from "./location-picker";
import type { EditorOptions } from "./queries";
import { ValuePicker } from "./saved-values";
import { TextWithVariables } from "./text-with-variables";

/*
 * The settings of a Utility step: one small form per function, plus the name its result is saved as.
 * The function itself is chosen in the step picker and doesn't change here.
 */

type Config = Record<string, unknown>;
type FormProps = {
  config: Config;
  set: (patch: Config) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
};

/** The name a new utility's result gets: "distance", then "distance2"… */
const baseNames: Record<UtilityFn, string> = {
  distance: "distance",
  nearest: "nearest",
  date_time: "date",
  date_diff: "days",
  calculate: "total",
  change_text: "text",
  find_in_text: "found",
  reference_code: "ref",
  lookup: "lookup",
};

/** A new Utility step's settings: the function's defaults, an unused name, the browser's timezone. */
export function newUtilityConfig(fn: UtilityFn, def: AutomationDefinition): UtilityConfig {
  const taken = new Set(def.nodes.map((n) => String((n.config as { saveAs?: unknown }).saveAs ?? "")));
  const base = baseNames[fn];
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  const c = utilityDefaults(fn, name);
  if ("timezone" in c) c.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return c;
}

export function UtilityForm({ config, set, def, options }: FormProps) {
  const fn = String(config.fn ?? "") as UtilityFn;
  const d = utilityDef(fn);
  if (!d)
    return <p className="text-sm text-destructive">This utility isn't known to this version of Relay.</p>;
  const saveAs = String(config.saveAs ?? "");
  return (
    <>
      {fn === "distance" ? (
        <DistanceForm config={config} set={set} def={def} options={options} />
      ) : fn === "nearest" ? (
        <NearestForm config={config} set={set} def={def} options={options} />
      ) : fn === "date_time" ? (
        <DateTimeForm config={config} set={set} def={def} options={options} />
      ) : fn === "date_diff" ? (
        <DateDiffForm config={config} set={set} def={def} options={options} />
      ) : fn === "calculate" ? (
        <CalculateForm config={config} set={set} def={def} options={options} />
      ) : fn === "change_text" ? (
        <ChangeTextForm config={config} set={set} def={def} options={options} />
      ) : fn === "find_in_text" ? (
        <FindForm config={config} set={set} def={def} options={options} />
      ) : fn === "reference_code" ? (
        <CodeForm config={config} set={set} />
      ) : fn === "lookup" ? (
        <LookupForm config={config} set={set} def={def} options={options} />
      ) : null}
      <Field
        label="Save the result as"
        hint={
          <>
            Use it in later steps as <code className="font-mono">{`{{values.${saveAs || "name"}}}`}</code>
            {d.parts.length ? (
              <>
                , or a part:{" "}
                {d.parts.map((p, i) => (
                  <span key={p}>
                    {i ? ", " : ""}
                    <code className="font-mono">.{p}</code>
                  </span>
                ))}
              </>
            ) : null}
            .
          </>
        }
      >
        <TextInput
          value={saveAs}
          maxLength={40}
          onChange={(e) => set({ saveAs: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
        />
      </Field>
    </>
  );
}

// ---------------------------------------------------------------- location

const unitOptions = [
  { value: "km", label: "Kilometres" },
  { value: "mi", label: "Miles" },
];

function PlaceCard({
  place,
  onChange,
  emptyLabel = "Choose on map",
}: {
  place: ChosenLocation | null;
  onChange: (p: ChosenLocation) => void;
  emptyLabel?: string;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      {place ? (
        <div className="flex items-start gap-3 rounded-md border px-3 py-2.5">
          <Icon name="location" size="sm" className="mt-0.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{place.name || "Pin without a name"}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground tabular-nums">
              {place.address || `${place.latitude}, ${place.longitude}`}
            </p>
          </div>
          <Button variant="outline" size="xs" onClick={() => setPicking(true)}>
            Change
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setPicking(true)}>
          <Icon name="location" />
          {emptyLabel}
        </Button>
      )}
      <LocationPicker open={picking} onOpenChange={setPicking} value={place} onChoose={onChange} />
    </>
  );
}

const chosen = (p: { latitude?: number; longitude?: number } | undefined): p is ChosenLocation =>
  !!p && !(Number(p.latitude ?? 0) === 0 && Number(p.longitude ?? 0) === 0);

function DistanceForm({ config, set, def, options }: FormProps) {
  const to = (config.to ?? { kind: "place" }) as
    | { kind: "place"; place?: ChosenLocation }
    | { kind: "answer"; path?: string };
  return (
    <>
      <Field label="From" hint="A location they shared with an “Ask for location” step.">
        <ValuePicker
          size="md"
          aria-label="From"
          value={String(config.from ?? "")}
          onChange={(from) => set({ from })}
          def={def}
          options={options}
          kinds={["location"]}
          placeholder="Pick a shared location"
        />
      </Field>
      <Field label="To">
        {() => (
          <div className="flex flex-col gap-2">
            <Segmented
              aria-label="To"
              value={to.kind}
              onChange={(kind) =>
                set({
                  to:
                    kind === "place"
                      ? { kind, place: { name: "", address: "", latitude: 0, longitude: 0 } }
                      : { kind: "answer", path: "" },
                })
              }
              options={[
                { value: "place", label: "A place you choose" },
                { value: "answer", label: "Another shared location" },
              ]}
            />
            {to.kind === "place" ? (
              <PlaceCard
                place={chosen(to.place) ? to.place : null}
                onChange={(place) => set({ to: { kind: "place", place } })}
              />
            ) : (
              <ValuePicker
                aria-label="To"
                value={to.path ?? ""}
                onChange={(path) => set({ to: { kind: "answer", path } })}
                def={def}
                options={options}
                kinds={["location"]}
                placeholder="Pick a shared location"
              />
            )}
          </div>
        )}
      </Field>
      <Field label="Show it in">
        <Segmented
          aria-label="Unit"
          value={String(config.unit ?? "km")}
          onChange={(unit) => set({ unit })}
          options={unitOptions}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        A straight line between the two pins, not the driving distance. If they typed an address instead of
        sharing a pin, it takes “No pin shared”.
      </p>
    </>
  );
}

type NearPlace = { name: string; address: string; latitude: number; longitude: number };

function NearestForm({ config, set, def, options }: FormProps) {
  const places = (config.places ?? []) as NearPlace[];
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const current = typeof editing === "number" ? (places[editing] ?? null) : null;
  return (
    <>
      <Field label="From" hint="A location they shared with an “Ask for location” step.">
        <ValuePicker
          size="md"
          aria-label="From"
          value={String(config.from ?? "")}
          onChange={(from) => set({ from })}
          def={def}
          options={options}
          kinds={["location"]}
          placeholder="Pick a shared location"
        />
      </Field>
      <Field label="Your places" hint="Two to twenty: branches, stores, pickup points.">
        {() => (
          <div className="flex flex-col gap-2">
            {places.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: places have no ids; their order is their identity
              <div key={i} className="flex items-start gap-2 rounded-md border px-3 py-2">
                <Icon name="location" size="sm" className="mt-2 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <TextInput
                    size="sm"
                    aria-label="Place name"
                    maxLength={100}
                    value={p.name}
                    onChange={(e) =>
                      set({ places: places.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                    }
                  />
                  <span className="truncate text-xs text-muted-foreground tabular-nums">
                    {p.address || `${p.latitude}, ${p.longitude}`}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move the pin"
                  onClick={() => setEditing(i)}
                >
                  <Icon name="edit" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove the place"
                  onClick={() => set({ places: places.filter((_, j) => j !== i) })}
                >
                  <Icon name="delete" />
                </Button>
              </div>
            ))}
            {places.length < 20 ? (
              <Button variant="outline" size="sm" className="self-start" onClick={() => setEditing("new")}>
                <Icon name="add" />
                Add a place
              </Button>
            ) : null}
          </div>
        )}
      </Field>
      <Field label="Show distance in">
        <Segmented
          aria-label="Unit"
          value={String(config.unit ?? "km")}
          onChange={(unit) => set({ unit })}
          options={unitOptions}
        />
      </Field>
      <LocationPicker
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        value={current}
        onChoose={(l) => {
          const place = { ...l, name: l.name || current?.name || `Place ${places.length + 1}` };
          set({
            places:
              editing === "new"
                ? [...places, place]
                : places.map((x, j) => (j === editing ? { ...x, ...place } : x)),
          });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- dates

function DateTimeForm({ config, set, def, options }: FormProps) {
  const change = String(config.change ?? "none");
  return (
    <>
      <Field label="Start from">
        <ValuePicker
          size="md"
          aria-label="Start from"
          value={String(config.start ?? "today")}
          onChange={(start) => set({ start })}
          def={def}
          options={options}
          kinds={["date", "text"]}
          extra={[{ value: "today", label: "Now (when this runs)" }]}
        />
      </Field>
      <Field label="Then">
        <Segmented
          aria-label="Change"
          value={change}
          onChange={(c) => set({ change: c })}
          options={[
            { value: "none", label: "Keep it" },
            { value: "add", label: "Add" },
            { value: "subtract", label: "Subtract" },
          ]}
        />
      </Field>
      {change !== "none" ? (
        <div className="grid grid-cols-[96px_1fr] gap-2">
          <TextInput
            type="number"
            min={0}
            max={10000}
            aria-label="Amount"
            value={Number(config.amount ?? 1)}
            onChange={(e) => set({ amount: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
          />
          <SelectField
            aria-label="Unit"
            value={String(config.unit ?? "days")}
            onValueChange={(unit) => set({ unit })}
            options={["minutes", "hours", "days", "weeks", "months", "years"].map((u) => ({
              value: u,
              label: u,
            }))}
          />
        </div>
      ) : null}
      <Field label="Show">
        <Segmented
          aria-label="Show"
          value={String(config.show ?? "date")}
          onChange={(show) => set({ show })}
          options={[
            { value: "date", label: "Date" },
            { value: "date_time", label: "Date and time" },
            { value: "time", label: "Time" },
          ]}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Like “Tue, 17 Nov 2026”. Parts give the weekday, the time, or morning/afternoon/evening for a
        greeting. Time zone {String(config.timezone ?? "")}.
      </p>
    </>
  );
}

function DateDiffForm({ config, set, def, options }: FormProps) {
  const pick = (key: "from" | "to", label: string) => (
    <Field label={label}>
      <ValuePicker
        size="md"
        aria-label={label}
        value={String(config[key] ?? "")}
        onChange={(v) => set({ [key]: v })}
        def={def}
        options={options}
        kinds={["date", "text"]}
        extra={[{ value: "today", label: "Today (when this runs)" }]}
        placeholder="Pick a date"
      />
    </Field>
  );
  return (
    <>
      {pick("from", "From")}
      {pick("to", "To")}
      <p className="text-xs text-muted-foreground">
        Whole days, weeks, months and years from the first date to the second. From a date of birth to today
        gives their age in years. Time zone {String(config.timezone ?? "")}.
      </p>
    </>
  );
}

// ---------------------------------------------------------------- numbers and text

function CalculateForm({ config, set, def, options }: FormProps) {
  return (
    <>
      <TextWithVariables
        label="Formula"
        hint="Use + − * / % and brackets, round(x, 2), min, max. Example: {{answers.qty}} * 250 + 50"
        value={String(config.formula ?? "")}
        onChange={(formula) => set({ formula })}
        def={def}
        options={options}
        rows={2}
        max={500}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Decimals">
          <SelectField
            value={String(config.decimals ?? 2)}
            onValueChange={(v) => set({ decimals: Number(v) })}
            options={[0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
          />
        </Field>
        <Field label="Currency" optional>
          <SelectField
            value={String(config.currency ?? "") || "none"}
            onValueChange={(v) => set({ currency: v === "none" ? "" : v })}
            options={[{ value: "none", label: "None" }, ...currencies.map((c) => ({ value: c, label: c }))]}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        If a value in it isn't a number, it takes “Couldn't work it out”.
      </p>
    </>
  );
}

function ChangeTextForm({ config, set, def, options }: FormProps) {
  return (
    <>
      <TextWithVariables
        label="Text"
        value={String(config.text ?? "")}
        onChange={(text) => set({ text })}
        def={def}
        options={options}
        rows={2}
      />
      <Field label="Change it to">
        <SelectField
          value={String(config.mode ?? "title")}
          onValueChange={(mode) => set({ mode })}
          options={[
            { value: "title", label: "Title Case (asha menon → Asha Menon)" },
            { value: "upper", label: "CAPITALS" },
            { value: "lower", label: "lower case" },
            { value: "first_word", label: "Just the first word" },
            { value: "shorten", label: "Shorter" },
          ]}
        />
      </Field>
      {config.mode === "shorten" ? (
        <Field label="At most" hint="characters, with … at the end when cut.">
          <TextInput
            type="number"
            min={1}
            max={1000}
            value={Number(config.maxLength ?? 20)}
            onChange={(e) => set({ maxLength: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
          />
        </Field>
      ) : null}
    </>
  );
}

function FindForm({ config, set, def, options }: FormProps) {
  return (
    <>
      <TextWithVariables
        label="Look in"
        value={String(config.text ?? "")}
        onChange={(text) => set({ text })}
        def={def}
        options={options}
        rows={2}
      />
      <Field label="Find">
        <SelectField
          value={String(config.find ?? "number")}
          onValueChange={(find) => set({ find })}
          options={[
            { value: "number", label: "A number (order no, amount)" },
            { value: "email", label: "An email address" },
            { value: "phone", label: "A phone number" },
            { value: "pincode", label: "A PIN code (6 digits)" },
            { value: "link", label: "A link" },
          ]}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Saves the first one found; <code className="font-mono">.all</code> has every one. None found takes
        “Not found”.
      </p>
    </>
  );
}

function CodeForm({ config, set }: Pick<FormProps, "config" | "set">) {
  const length = Number(config.length ?? 6);
  const chars = String(config.chars ?? "both");
  const example = (chars === "digits" ? "48273956" : chars === "letters" ? "KMQRTWXZ" : "7K4Q9PXM")
    .repeat(2)
    .slice(0, length);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts with" optional>
          <TextInput
            value={String(config.prefix ?? "")}
            maxLength={10}
            placeholder="BK-"
            onChange={(e) => set({ prefix: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })}
          />
        </Field>
        <Field label="Length">
          <SelectField
            value={String(length)}
            onValueChange={(v) => set({ length: Number(v) })}
            options={[4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => ({ value: String(n), label: String(n) }))}
          />
        </Field>
      </div>
      <Field label="Made of">
        <Segmented
          aria-label="Made of"
          value={chars}
          onChange={(c) => set({ chars: c })}
          options={[
            { value: "both", label: "Letters and digits" },
            { value: "digits", label: "Digits" },
            { value: "letters", label: "Letters" },
          ]}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Like <span className="font-mono">{`${String(config.prefix ?? "")}${example}`}</span>. Letters and
        digits that look alike (0 and O, 1 and I) are left out.
      </p>
    </>
  );
}

function LookupForm({ config, set, def, options }: FormProps) {
  const rows = (config.rows ?? []) as { key: string; value: string }[];
  const setRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    set({ rows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <>
      <TextWithVariables
        label="Look up"
        hint="Usually an answer, like {{answers.city}}. Capitals and spaces around it don't matter."
        value={String(config.key ?? "")}
        onChange={(key) => set({ key })}
        def={def}
        options={options}
        rows={1}
      />
      <Field label="Table">
        {() => (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_1fr_32px] gap-2 text-xs text-muted-foreground">
              <span>When it is</span>
              <span>Save</span>
            </div>
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no ids; their order is their identity
              <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2">
                <TextInput
                  size="sm"
                  aria-label="When it is"
                  maxLength={200}
                  value={r.key}
                  onChange={(e) => setRow(i, { key: e.target.value })}
                />
                <TextInput
                  size="sm"
                  aria-label="Save"
                  maxLength={1024}
                  value={r.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove the row"
                  disabled={rows.length <= 1}
                  onClick={() => set({ rows: rows.filter((_, j) => j !== i) })}
                >
                  <Icon name="close" />
                </Button>
              </div>
            ))}
            {rows.length < 100 ? (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => set({ rows: [...rows, { key: "", value: "" }] })}
              >
                <Icon name="add" />
                Add row
              </Button>
            ) : null}
          </div>
        )}
      </Field>
      <Field label="If nothing matches, save" optional hint="It takes “Not found” either way.">
        <TextInput
          value={String(config.fallback ?? "")}
          maxLength={1024}
          onChange={(e) => set({ fallback: e.target.value })}
        />
      </Field>
    </>
  );
}

/** For the step picker: each function as its own entry under Utilities. */
export const utilityEntries = (Object.keys(utilityFunctions) as UtilityFn[]).map((fn) => {
  const d = utilityFunctions[fn];
  return { fn, label: d.label, description: d.description, icon: d.icon, group: d.group };
});
