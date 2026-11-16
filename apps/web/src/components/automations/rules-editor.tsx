"use client";

import {
  type AutomationDefinition,
  type BranchConfig,
  type ConditionRule,
  type DateOp,
  dateOpNeeds,
  dateOps,
  shortId,
  todayOps,
} from "@relay/core/automations";
import { Segmented } from "@relay/ui/components/choice";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import type { EditorOptions } from "./queries";
import { ValuePicker } from "./saved-values";

/*
 * The rules of a Condition and of each Branch path: one editor for both, so a rule means the same in
 * either. A rule checks a saved value, a date, business hours, the 24-hour window, or a tag.
 */

type Config = Record<string, unknown>;
type DateRule = Extract<ConditionRule, { kind: "date" }>;
type ValueRule = Extract<ConditionRule, { kind: "answer" | "variable" }>;

export const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const valueOpOptions = [
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
  { value: "is_one_of", label: "is one of" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "starts_with", label: "starts with" },
  { value: "gt", label: "is more than" },
  { value: "lt", label: "is less than" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "isn't empty" },
];

const dateOpLabels: Record<DateOp, string> = {
  is_today: "is today",
  is_tomorrow: "is tomorrow",
  is_past: "is in the past",
  is_future: "is in the future",
  in_next_days: "is within the next",
  in_last_days: "was within the last",
  more_than_days_away: "is more than … days away",
  more_than_days_ago: "was more than … days ago",
  before: "is before",
  on: "is on",
  after: "is after",
  between: "is between",
  weekday_in: "falls on",
  not_a_date: "isn't a date",
};
const todayOpLabels: Partial<Record<DateOp, string>> = {
  on: "is",
  between: "is between",
  before: "is before",
  after: "is after",
  weekday_in: "is a",
};

function newRule(kind: string, def: AutomationDefinition): ConditionRule {
  switch (kind) {
    case "window_open":
      return { kind };
    case "business_hours":
      return { kind, days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00", timezone: browserZone() };
    case "date":
      return { kind, source: "today", op: "weekday_in", weekdays: [5], timezone: browserZone() };
    case "contact":
      return { kind, rule: { field: "tags", op: "has_any", value: [] } };
    default: {
      const firstAnswer = def.nodes
        .map((n) => (n.config as { saveAs?: unknown }).saveAs)
        .find(
          (s): s is string =>
            typeof s === "string" &&
            !!s &&
            !def.nodes.some((x) => x.type === "utility" && (x.config as { saveAs?: unknown }).saveAs === s),
        );
      return { kind: "variable", name: firstAnswer ? `answers.${firstAnswer}` : "", op: "is", value: "" };
    }
  }
}

/** A list of rules with "all / any". */
export function RulesEditor({
  match,
  rules,
  onChange,
  def,
  options,
  matchLabel,
}: {
  match: "all" | "any";
  rules: ConditionRule[];
  onChange: (patch: { match?: "all" | "any"; rules?: ConditionRule[] }) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
  matchLabel: string;
}) {
  const update = (i: number, rule: ConditionRule) =>
    onChange({ rules: rules.map((r, j) => (j === i ? rule : r)) });
  return (
    <div className="flex flex-col gap-3">
      {rules.length > 1 ? (
        <Field label={matchLabel}>
          <Segmented
            aria-label="Match"
            value={match}
            onChange={(m) => onChange({ match: m as "all" | "any" })}
            options={[
              { value: "all", label: "All rules match" },
              { value: "any", label: "Any rule matches" },
            ]}
          />
        </Field>
      ) : null}
      {rules.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids; their order is their identity
        <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <SelectField
              size="sm"
              className="flex-1"
              aria-label="Rule"
              value={r.kind === "answer" ? "variable" : r.kind}
              onValueChange={(kind) => update(i, newRule(kind, def))}
              options={[
                { value: "variable", label: "A value" },
                { value: "date", label: "A date" },
                { value: "business_hours", label: "Within business hours" },
                { value: "window_open", label: "They wrote in the last 24 h" },
                { value: "contact", label: "The contact has a tag" },
              ]}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove the rule"
              disabled={rules.length <= 1}
              onClick={() => onChange({ rules: rules.filter((_, j) => j !== i) })}
            >
              <Icon name="close" />
            </Button>
          </div>
          {r.kind === "answer" || r.kind === "variable" ? (
            <ValueRuleEditor rule={r} onChange={(rule) => update(i, rule)} def={def} options={options} />
          ) : r.kind === "date" ? (
            <DateRuleEditor rule={r} onChange={(rule) => update(i, rule)} def={def} options={options} />
          ) : r.kind === "business_hours" ? (
            <div className="flex flex-col gap-2">
              <WeekdayToggles days={r.days} onChange={(days) => update(i, { ...r, days })} />
              <div className="grid grid-cols-2 gap-2">
                <TextInput
                  size="sm"
                  type="time"
                  aria-label="From"
                  value={r.from}
                  onChange={(e) => update(i, { ...r, from: e.target.value })}
                />
                <TextInput
                  size="sm"
                  type="time"
                  aria-label="To"
                  value={r.to}
                  onChange={(e) => update(i, { ...r, to: e.target.value })}
                />
              </div>
              <span className="text-xs text-muted-foreground">Time zone {r.timezone}</span>
            </div>
          ) : r.kind === "contact" ? (
            <ContactTagRule rule={r} tags={options?.tags ?? []} onChange={(rule) => update(i, rule)} />
          ) : (
            <p className="text-xs text-muted-foreground">
              True when they wrote in the last 24 hours, so free-form messages can still go out.
            </p>
          )}
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange({ rules: [...rules, newRule("variable", def)] })}
      >
        <Icon name="add" />
        Add rule
      </Button>
    </div>
  );
}

function ValueRuleEditor({
  rule,
  onChange,
  def,
  options,
}: {
  rule: ValueRule;
  onChange: (r: ConditionRule) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
}) {
  // Older rules name an answer; show them as the value they are.
  const path = rule.kind === "answer" ? `answers.${rule.name}` : rule.name;
  const asVariable = (patch: Partial<ValueRule>): ConditionRule => ({
    kind: "variable",
    name: path,
    op: rule.op,
    value: rule.value ?? "",
    ...patch,
  });
  const noValue = rule.op === "is_empty" || rule.op === "is_not_empty";
  return (
    <div className="flex flex-col gap-2">
      <ValuePicker
        aria-label="Value"
        value={path}
        onChange={(name) => onChange(asVariable({ name }))}
        def={def}
        options={options}
      />
      <div className={noValue ? "grid grid-cols-1" : "grid grid-cols-[auto_1fr] gap-2"}>
        <SelectField
          size="sm"
          aria-label="Is"
          value={rule.op}
          onValueChange={(op) => onChange(asVariable({ op: op as ValueRule["op"] }))}
          options={valueOpOptions}
        />
        {noValue ? null : (
          <TextInput
            size="sm"
            aria-label="Compared with"
            placeholder={rule.op === "is_one_of" ? "Dubai, Sharjah, Ajman" : "Value"}
            value={rule.value ?? ""}
            onChange={(e) => onChange(asVariable({ value: e.target.value }))}
          />
        )}
      </div>
      {rule.op === "is_one_of" ? (
        <span className="text-xs text-muted-foreground">Separate the choices with commas.</span>
      ) : null}
    </div>
  );
}

function DateRuleEditor({
  rule,
  onChange,
  def,
  options,
}: {
  rule: DateRule;
  onChange: (r: ConditionRule) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
}) {
  const isToday = rule.source === "today";
  const ops = (isToday ? todayOps : dateOps).map((op) => ({
    value: op,
    label: (isToday ? todayOpLabels[op] : undefined) ?? dateOpLabels[op],
  }));
  const needs = dateOpNeeds[rule.op];
  const set = (patch: Partial<DateRule>) => onChange({ ...rule, ...patch });
  return (
    <div className="flex flex-col gap-2">
      <ValuePicker
        aria-label="Date"
        value={rule.source}
        onChange={(source) =>
          set(
            source === "today" && !todayOps.includes(rule.op)
              ? { source, op: "on" }
              : source !== "today" && rule.source === "today"
                ? { source, op: "in_next_days", days: rule.days ?? 7 }
                : { source },
          )
        }
        def={def}
        options={options}
        kinds={["date", "text"]}
        extra={[{ value: "today", label: "Today (when this runs)" }]}
      />
      <SelectField
        size="sm"
        aria-label="Check"
        value={rule.op}
        onValueChange={(op) => set({ op: op as DateOp })}
        options={ops}
      />
      {needs === "days" ? (
        <div className="flex items-center gap-2">
          <TextInput
            size="sm"
            type="number"
            min={0}
            max={3650}
            aria-label="Days"
            className="w-24"
            value={rule.days ?? ""}
            onChange={(e) =>
              set({ days: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })
            }
          />
          <span className="text-sm text-muted-foreground">days</span>
        </div>
      ) : needs === "date" ? (
        <TextInput
          size="sm"
          type="date"
          aria-label="Date"
          value={rule.date ?? ""}
          onChange={(e) => set({ date: e.target.value || undefined })}
        />
      ) : needs === "range" ? (
        <div className="grid grid-cols-2 gap-2">
          <TextInput
            size="sm"
            type="date"
            aria-label="From"
            value={rule.date ?? ""}
            onChange={(e) => set({ date: e.target.value || undefined })}
          />
          <TextInput
            size="sm"
            type="date"
            aria-label="To"
            value={rule.to ?? ""}
            onChange={(e) => set({ to: e.target.value || undefined })}
          />
        </div>
      ) : needs === "weekdays" ? (
        <WeekdayToggles days={rule.weekdays ?? []} onChange={(w) => set({ weekdays: w })} />
      ) : null}
      <span className="text-xs text-muted-foreground">
        {rule.op === "in_next_days" ? "Counts today. " : ""}Days are counted in {rule.timezone}.
      </span>
    </div>
  );
}

function WeekdayToggles({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {weekdays.map((d, n) => (
        <Button
          key={d}
          size="xs"
          variant={days.includes(n) ? "default" : "outline"}
          aria-pressed={days.includes(n)}
          onClick={() => onChange(days.includes(n) ? days.filter((x) => x !== n) : [...days, n].sort())}
        >
          {d}
        </Button>
      ))}
    </div>
  );
}

function ContactTagRule({
  rule,
  tags,
  onChange,
}: {
  rule: Extract<ConditionRule, { kind: "contact" }>;
  tags: { id: string; name: string }[];
  onChange: (r: ConditionRule) => void;
}) {
  const options = tags.map((t) => ({ value: t.id, label: t.name }));
  const value = Array.isArray(rule.rule.value) ? (rule.rule.value as string[]) : [];
  return (
    <div className="grid grid-cols-2 gap-2">
      <SelectField
        size="sm"
        aria-label="Has"
        value={rule.rule.op}
        onValueChange={(op) => onChange({ kind: "contact", rule: { field: "tags", op, value } })}
        options={[
          { value: "has_any", label: "has the tag" },
          { value: "has_none", label: "doesn't have it" },
        ]}
      />
      <SelectField
        size="sm"
        aria-label="Tag"
        value={value[0] ?? ""}
        placeholder="Pick a tag"
        onValueChange={(tag) =>
          onChange({ kind: "contact", rule: { field: "tags", op: rule.rule.op, value: [tag] } })
        }
        options={options}
      />
    </div>
  );
}

type FormProps = {
  config: Config;
  set: (patch: Config) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
};

export function ConditionForm({ config, set, def, options }: FormProps) {
  return (
    <RulesEditor
      match={(config.match as "all" | "any") ?? "all"}
      rules={(config.rules ?? []) as ConditionRule[]}
      onChange={(patch) => set(patch)}
      def={def}
      options={options}
      matchLabel="Go “Yes” when"
    />
  );
}

/** Branch: named paths, checked top to bottom; each has its own rules. */
export function BranchForm({ config, set, def, options }: FormProps) {
  const paths = ((config as BranchConfig).paths ?? []) as BranchConfig["paths"];
  const update = (i: number, patch: Partial<BranchConfig["paths"][number]>) =>
    set({ paths: paths.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const move = (i: number, by: -1 | 1) => {
    const next = [...paths];
    const [p] = next.splice(i, 1);
    if (p) next.splice(i + by, 0, p);
    set({ paths: next });
  };
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Paths are checked from the top. The first one whose rules match is taken; if none do, it goes
        “Otherwise”.
      </p>
      {paths.map((p, i) => (
        <section
          key={p.id}
          className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3"
          aria-label={`Path ${p.name}`}
        >
          <div className="flex items-center gap-1">
            <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
            <TextInput
              size="sm"
              aria-label="Path name"
              className="flex-1"
              maxLength={30}
              value={p.name}
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Move up"
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <Icon name="arrowUp" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Move down"
              disabled={i === paths.length - 1}
              onClick={() => move(i, 1)}
            >
              <Icon name="arrowDown" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove the path"
              disabled={paths.length <= 1}
              onClick={() => set({ paths: paths.filter((_, j) => j !== i) })}
            >
              <Icon name="delete" />
            </Button>
          </div>
          <RulesEditor
            match={p.match ?? "all"}
            rules={p.rules}
            onChange={(patch) => update(i, patch)}
            def={def}
            options={options}
            matchLabel="Take this path when"
          />
        </section>
      ))}
      {paths.length < 10 ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            set({
              paths: [
                ...paths,
                {
                  id: shortId(),
                  name: `Path ${paths.length + 1}`,
                  match: "all",
                  rules: [newRule("variable", def)],
                },
              ],
            })
          }
        >
          <Icon name="add" />
          Add path
        </Button>
      ) : null}
    </>
  );
}
