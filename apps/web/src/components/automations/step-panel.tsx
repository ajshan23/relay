"use client";

import {
  type AskQuestionConfig,
  type AutomationDefinition,
  type ConditionRule,
  type Issue,
  nodeSpec,
  TRIGGER_NODE_ID,
  type Trigger,
  type WaitConfig,
} from "@relay/core/automations";
import { Segmented } from "@relay/ui/components/choice";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Textarea } from "@relay/ui/ui/textarea";
import { useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { stepIcons, stepSummary } from "./canvas";
import { handlesOf, nodeById } from "./ops";
import type { EditorOptions } from "./queries";
import { triggerLabels } from "./words";

/*
 * The settings of the selected step (or the trigger), docked beside the canvas. Every change is
 * saved as you type (the editor autosaves the draft). Problems found by validation show at the top.
 */

type Config = Record<string, unknown>;

export type StepPanelProps = {
  def: AutomationDefinition;
  nodeId: string;
  issues: Issue[];
  options?: EditorOptions;
  readOnly: boolean;
  onConfig: (config: Config) => void;
  onTrigger: (trigger: Trigger) => void;
  onExit: (handle: string, target: string | null) => void;
  onDelete: () => void;
  onClose: () => void;
};

export function StepPanel(p: StepPanelProps) {
  const isTrigger = p.nodeId === TRIGGER_NODE_ID;
  const node = nodeById(p.def, p.nodeId);
  if (!isTrigger && !node) return null;
  const spec = node ? nodeSpec(node.type) : null;
  const mine = p.issues.filter((i) => i.nodeId === p.nodeId);
  const config = (node?.config ?? {}) as Config;
  const set = (patch: Config) => p.onConfig({ ...config, ...patch });

  return (
    <aside className="flex h-full w-full flex-col border-l bg-background" aria-label="Step settings">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <span className="inline-flex size-7 items-center justify-center rounded-md bg-muted">
          <Icon name={isTrigger ? "zap" : (stepIcons[node?.type ?? ""] ?? "automation")} size="sm" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{isTrigger ? "Trigger" : spec?.label}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {isTrigger ? "What starts this automation" : spec?.description}
          </p>
        </div>
        {!isTrigger && !p.readOnly ? (
          <Button variant="ghost" size="icon-sm" aria-label="Delete this step" onClick={p.onDelete}>
            <Icon name="delete" />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label="Close the settings" onClick={p.onClose}>
          <Icon name="close" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        {mine.length ? (
          <ul className="flex flex-col gap-1.5">
            {mine.map((i) => (
              <li
                key={`${i.code}-${i.message}`}
                className={i.level === "error" ? "text-[13px] text-destructive" : "text-[13px] text-warning"}
              >
                {i.message}
              </li>
            ))}
          </ul>
        ) : null}
        <fieldset disabled={p.readOnly} className="flex flex-col gap-5 disabled:opacity-80">
          {isTrigger ? (
            <TriggerForm trigger={p.def.trigger} options={p.options} onChange={p.onTrigger} />
          ) : node?.type === "send_message" ? (
            <SendMessageForm config={config} set={set} def={p.def} options={p.options} />
          ) : node?.type === "send_template" ? (
            <TemplateForm config={config} set={set} def={p.def} options={p.options} />
          ) : node?.type === "ask_question" ? (
            <AskForm
              config={config as unknown as AskQuestionConfig}
              set={set}
              def={p.def}
              options={p.options}
            />
          ) : node?.type === "condition" ? (
            <ConditionForm config={config} set={set} def={p.def} options={p.options} />
          ) : node?.type === "wait" ? (
            <WaitForm config={config as unknown as WaitConfig} onChange={p.onConfig} />
          ) : node?.type === "add_tag" || node?.type === "remove_tag" ? (
            <Field label="Tag">
              <SelectField
                value={String(config.tagId ?? "")}
                onValueChange={(tagId) => set({ tagId })}
                placeholder="Pick a tag"
                options={(p.options?.tags ?? []).map((t) => ({ value: t.id, label: t.name }))}
              />
            </Field>
          ) : node?.type === "set_field" ? (
            <>
              <Field label="Contact field">
                <SelectField
                  value={String(config.fieldKey ?? "")}
                  onValueChange={(fieldKey) => set({ fieldKey })}
                  placeholder="Pick a field"
                  options={(p.options?.fields ?? []).map((f) => ({ value: f.key, label: f.label }))}
                />
              </Field>
              <TextWithVariables
                label="Value"
                hint="Usually an answer, like {{answers.city}}."
                value={String(config.value ?? "")}
                onChange={(value) => set({ value })}
                def={p.def}
                options={p.options}
                rows={2}
              />
            </>
          ) : node?.type === "assign" ? (
            <Field label="Assign to" hint="Only people who work in this branch.">
              <SelectField
                value={String(config.userId ?? "none")}
                onValueChange={(v) => set({ userId: v === "none" ? null : v })}
                options={[
                  { value: "none", label: "Nobody (unassign)" },
                  ...(p.options?.users ?? []).map((u) => ({ value: u.id, label: u.name })),
                ]}
              />
            </Field>
          ) : node?.type === "add_note" ? (
            <TextWithVariables
              label="Note"
              hint="Only your team sees notes."
              value={String(config.text ?? "")}
              onChange={(text) => set({ text })}
              def={p.def}
              options={p.options}
            />
          ) : node?.type === "handoff" ? (
            <>
              <Field label="Assign to" hint="Or leave it open for anyone on the team.">
                <SelectField
                  value={String(config.userId ?? "none")}
                  onValueChange={(v) => set({ userId: v === "none" ? null : v })}
                  options={[
                    { value: "none", label: "Anyone (leave unassigned)" },
                    ...(p.options?.users ?? []).map((u) => ({ value: u.id, label: u.name })),
                  ]}
                />
              </Field>
              <TextWithVariables
                label="Note for the team"
                optional
                value={String(config.note ?? "")}
                onChange={(note) => set({ note })}
                def={p.def}
                options={p.options}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                The automation stops here and the chat opens for the team.
              </p>
            </>
          ) : node?.type === "close_chat" ? (
            <p className="text-sm text-muted-foreground">
              Marks the chat as closed. A new message from them opens it again.
            </p>
          ) : node?.type === "end" ? (
            <p className="text-sm text-muted-foreground">
              The automation stops here. The chat goes back to the team.
            </p>
          ) : null}
        </fieldset>
        {!isTrigger && node ? <Exits {...p} /> : null}
      </div>
    </aside>
  );
}

/** Not a valid node id, so it never clashes with a step called "end". */
const ENDS = "__ends__";

/** Where each exit leads: the next step, another existing step, or the end. */
function Exits({ def, nodeId, onExit, readOnly, options }: StepPanelProps) {
  const node = nodeById(def, nodeId);
  const handles = handlesOf(node);
  if (!handles.length) return null;
  const others = def.nodes.filter((n) => n.id !== nodeId);
  return (
    <section className="flex flex-col gap-2 border-t pt-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase">Then</h3>
      {handles.map((h) => {
        const target = def.edges.find((e) => e.source === nodeId && e.sourceHandle === h.id)?.target ?? "";
        return (
          <div key={h.id} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-[13px]">{h.label}</span>
            <SelectField
              size="sm"
              className="min-w-0 flex-1"
              aria-label={`After “${h.label}”`}
              disabled={readOnly}
              value={target || ENDS}
              onValueChange={(v) => onExit(h.id, v === ENDS ? null : v)}
              options={[
                { value: ENDS, label: "End here" },
                ...others.map((n) => ({
                  value: n.id,
                  label: `${nodeSpec(n.type)?.label ?? n.type} · ${stepSummary(n, options).slice(0, 40)}`,
                })),
              ]}
            />
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------- trigger

function TriggerForm({
  trigger,
  options,
  onChange,
}: {
  trigger: Trigger;
  options?: EditorOptions;
  onChange: (t: Trigger) => void;
}) {
  const [keywords, setKeywords] = useState(
    trigger.type === "message_received" ? (trigger.keywords ?? []).join(", ") : "",
  );
  return (
    <>
      <Field label="Starts when">
        <SelectField
          value={trigger.type}
          onValueChange={(type) =>
            onChange(
              type === "message_received"
                ? { type, mode: "any" }
                : type === "ad_click"
                  ? { type }
                  : type === "tag_added"
                    ? { type, tagId: "" }
                    : { type: "run_from_chat" },
            )
          }
          options={Object.entries(triggerLabels).map(([value, label]) => ({ value, label }))}
        />
      </Field>
      {trigger.type === "message_received" ? (
        <>
          <Field label="Which messages">
            <Segmented
              aria-label="Which messages"
              value={trigger.mode}
              onChange={(mode) => onChange({ ...trigger, mode, match: trigger.match ?? "exact" })}
              options={[
                { value: "keyword", label: "Keywords" },
                { value: "first_message", label: "First message" },
                { value: "any", label: "Any" },
              ]}
            />
          </Field>
          {trigger.mode === "keyword" ? (
            <>
              <Field label="Keywords" hint="Separate them with commas. Capitals don't matter.">
                <TextInput
                  value={keywords}
                  placeholder="hi, hello, menu"
                  onChange={(e) => {
                    setKeywords(e.target.value);
                    onChange({
                      ...trigger,
                      keywords: e.target.value
                        .split(",")
                        .map((k) => k.trim())
                        .filter(Boolean),
                    });
                  }}
                />
              </Field>
              <Field label="Match">
                <Segmented
                  aria-label="Match"
                  value={trigger.match ?? "exact"}
                  onChange={(match) => onChange({ ...trigger, match })}
                  options={[
                    { value: "exact", label: "The whole message" },
                    { value: "contains", label: "A word in it" },
                  ]}
                />
              </Field>
            </>
          ) : trigger.mode === "any" ? (
            <p className="text-xs text-muted-foreground">
              More specific automations on this number (keywords, ads) win when both match a message.
            </p>
          ) : null}
        </>
      ) : trigger.type === "ad_click" ? (
        <Field
          label="Ad ids"
          optional
          hint="Leave empty for any click-to-WhatsApp ad. Separate ids with commas."
        >
          <TextInput
            defaultValue={(trigger.adIds ?? []).join(", ")}
            onChange={(e) =>
              onChange({
                type: "ad_click",
                adIds: e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      ) : trigger.type === "tag_added" ? (
        <Field
          label="Tag"
          hint="When a team member adds this tag to a contact who has a chat on this number."
        >
          <SelectField
            value={trigger.tagId}
            onValueChange={(tagId) => onChange({ type: "tag_added", tagId })}
            placeholder="Pick a tag"
            options={(options?.tags ?? []).map((t) => ({ value: t.id, label: t.name }))}
          />
        </Field>
      ) : (
        <p className="text-sm text-muted-foreground">
          Team members start it from a chat in the inbox (Run automation), for example to ask for feedback.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- messages

type FormProps = {
  config: Config;
  set: (patch: Config) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
};

function SendMessageForm({ config, set, def, options }: FormProps) {
  const media = config.media as { kind: string; fileId: string; name?: string } | null;
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (file: File) => {
    setUploading(true);
    const form = new FormData();
    form.set("use", "automation");
    form.set("file", file);
    try {
      const { upload } = await api<{ upload: { kind: string; fileId: string; fileName: string } }>(
        "/uploads",
        {
          method: "POST",
          body: form,
        },
      );
      set({ media: { kind: upload.kind, fileId: upload.fileId, name: upload.fileName } });
    } catch (err) {
      notify.error("File not added", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setUploading(false);
    }
  };
  return (
    <>
      <TextWithVariables
        label={media ? "Caption" : "Message"}
        value={String(config.text ?? "")}
        onChange={(text) => set({ text })}
        def={def}
        options={options}
        max={media ? 1024 : 4096}
      />
      <Field label="Photo, video or file" optional>
        {() =>
          media ? (
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Icon
                name={media.kind === "image" ? "image" : media.kind === "video" ? "video" : "file"}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate">{media.name ?? media.kind}</span>
              <Button variant="ghost" size="xs" onClick={() => set({ media: null })}>
                Remove
              </Button>
            </div>
          ) : (
            <div>
              <input
                ref={input}
                type="file"
                className="hidden"
                accept="image/jpeg,image/png,video/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
              <Button variant="outline" size="sm" disabled={uploading} onClick={() => input.current?.click()}>
                <Icon
                  name={uploading ? "loading" : "attach"}
                  className={uploading ? "animate-spin" : undefined}
                />
                {uploading ? "Uploading…" : "Add a file"}
              </Button>
            </div>
          )
        }
      </Field>
      <p className="text-xs text-muted-foreground">
        Free-form messages only go out within 24 hours of the customer's last message. Use a template
        otherwise.
      </p>
    </>
  );
}

function TemplateForm({ config, set, def, options }: FormProps) {
  const templates = options?.templates ?? [];
  const chosen = templates.find((t) => t.id === config.templateId);
  const values = (config.values ?? {}) as Record<string, string>;
  return (
    <>
      <Field label="Template" hint="Approved templates on this automation's number.">
        <SelectField
          value={String(config.templateId ?? "")}
          onValueChange={(templateId) => set({ templateId, values: {} })}
          placeholder="Pick a template"
          options={templates.map((t) => ({
            value: t.id,
            label: t.name,
            description: t.status === "ready" ? undefined : "Not approved yet",
          }))}
        />
      </Field>
      {chosen ? (
        <p className="rounded-md bg-muted px-3 py-2 text-[13px] whitespace-pre-wrap">{chosen.body}</p>
      ) : null}
      {chosen?.variables.map((v) => (
        <TextWithVariables
          key={v}
          label={`{{${v}}}`}
          value={values[v] ?? ""}
          onChange={(text) => set({ values: { ...values, [v]: text } })}
          def={def}
          options={options}
          rows={1}
        />
      ))}
    </>
  );
}

function AskForm({ config, set, def, options }: Omit<FormProps, "config"> & { config: AskQuestionConfig }) {
  const answer = config.answer;
  const opts = answer.type === "buttons" ? answer.options : [];
  const setOptions = (next: { id: string; title: string }[]) =>
    set({ answer: { type: "buttons", options: next } });
  const nextId = () => {
    let n = opts.length + 1;
    while (opts.some((o) => o.id === `a${n}`)) n++;
    return `a${n}`;
  };
  return (
    <>
      <TextWithVariables
        label="Question"
        value={config.text}
        onChange={(text) => set({ text })}
        def={def}
        options={options}
        max={1024}
      />
      <Field label="Answer">
        <Segmented
          aria-label="Answer"
          value={answer.type}
          onChange={(type) =>
            set({
              answer:
                type === "buttons"
                  ? {
                      type,
                      options: [
                        { id: "a1", title: "Yes" },
                        { id: "a2", title: "No" },
                      ],
                    }
                  : { type, format: "any" },
            })
          }
          options={[
            { value: "buttons", label: "Options" },
            { value: "text", label: "Typed answer" },
          ]}
        />
      </Field>
      {answer.type === "buttons" ? (
        <div className="flex flex-col gap-2">
          {opts.map((o, i) => (
            <div key={o.id} className="flex items-center gap-2">
              <TextInput
                aria-label={`Option ${i + 1}`}
                value={o.title}
                maxLength={24}
                size="sm"
                onChange={(e) =>
                  setOptions(opts.map((x) => (x.id === o.id ? { ...x, title: e.target.value } : x)))
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove option ${i + 1}`}
                disabled={opts.length <= 1}
                onClick={() => setOptions(opts.filter((x) => x.id !== o.id))}
              >
                <Icon name="close" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={opts.length >= 10}
              onClick={() => setOptions([...opts, { id: nextId(), title: `Option ${opts.length + 1}` }])}
            >
              <Icon name="add" />
              Add option
            </Button>
            <span className="text-xs text-muted-foreground">
              {opts.length <= 3
                ? "Shown as buttons (20 characters each)"
                : "Shown as a list (24 characters each)"}
            </span>
          </div>
        </div>
      ) : (
        <Field label="Format">
          <SelectField
            value={answer.format}
            onValueChange={(format) => set({ answer: { type: "text", format } })}
            options={[
              { value: "any", label: "Any text" },
              { value: "number", label: "A number" },
              { value: "email", label: "An email address" },
              { value: "phone", label: "A phone number" },
              { value: "date", label: "A date" },
            ]}
          />
        </Field>
      )}
      <Field label="Save the answer as" hint={`Use it later as {{answers.${config.saveAs || "name"}}}.`}>
        <TextInput
          value={config.saveAs}
          onChange={(e) =>
            set({
              saveAs: e.target.value
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, "_")
                .slice(0, 40),
            })
          }
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ask again" hint="Times, after an answer that doesn't fit.">
          <SelectField
            value={String(config.retries)}
            onValueChange={(v) => set({ retries: Number(v) })}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}×` }))}
          />
        </Field>
        <Field label="Wait for a reply" hint="Then “No reply”.">
          <SelectField
            value={String(config.timeoutMinutes)}
            onValueChange={(v) => set({ timeoutMinutes: Number(v) })}
            options={[
              [5, "5 minutes"],
              [15, "15 minutes"],
              [60, "1 hour"],
              [180, "3 hours"],
              [720, "12 hours"],
              [1440, "1 day"],
              [4320, "3 days"],
              [10080, "7 days"],
            ].map(([v, l]) => ({ value: String(v), label: String(l) }))}
          />
        </Field>
      </div>
      <TextWithVariables
        label="When the answer doesn't fit"
        value={config.retryText}
        onChange={(retryText) => set({ retryText })}
        def={def}
        options={options}
        rows={2}
      />
    </>
  );
}

// ---------------------------------------------------------------- logic

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ConditionForm({ config, set, def, options }: FormProps) {
  const rules = (config.rules ?? []) as ConditionRule[];
  const answers = def.nodes
    .filter((n) => n.type === "ask_question")
    .map((n) => String((n.config as { saveAs?: string }).saveAs ?? ""))
    .filter(Boolean);
  const update = (i: number, rule: ConditionRule) =>
    set({ rules: rules.map((r, j) => (j === i ? rule : r)) });
  return (
    <>
      <Field label="Go “Yes” when">
        <Segmented
          aria-label="Match"
          value={String(config.match ?? "all")}
          onChange={(match) => set({ match })}
          options={[
            { value: "all", label: "All rules match" },
            { value: "any", label: "Any rule matches" },
          ]}
        />
      </Field>
      {rules.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids; their order is their identity
        <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <SelectField
              size="sm"
              className="flex-1"
              aria-label="Rule"
              value={r.kind}
              onValueChange={(kind) =>
                update(
                  i,
                  kind === "window_open"
                    ? { kind }
                    : kind === "business_hours"
                      ? {
                          kind,
                          days: [1, 2, 3, 4, 5],
                          from: "09:00",
                          to: "18:00",
                          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                        }
                      : kind === "answer"
                        ? { kind, name: answers[0] ?? "", op: "is", value: "" }
                        : { kind: "contact", rule: { field: "tags", op: "has_any", value: [] } },
                )
              }
              options={[
                { value: "answer", label: "An answer" },
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
              onClick={() => set({ rules: rules.filter((_, j) => j !== i) })}
            >
              <Icon name="close" />
            </Button>
          </div>
          {r.kind === "answer" || r.kind === "variable" ? (
            <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
              <SelectField
                size="sm"
                aria-label="Answer"
                value={r.name}
                onValueChange={(name) => update(i, { ...r, name })}
                placeholder="Answer"
                options={answers.map((a) => ({ value: a, label: a }))}
              />
              <SelectField
                size="sm"
                aria-label="Is"
                value={r.op}
                onValueChange={(op) => update(i, { ...r, op })}
                options={[
                  { value: "is", label: "is" },
                  { value: "is_not", label: "is not" },
                  { value: "contains", label: "contains" },
                  { value: "gt", label: "more than" },
                  { value: "lt", label: "less than" },
                  { value: "is_empty", label: "is empty" },
                ]}
              />
              <TextInput
                size="sm"
                aria-label="Value"
                value={r.value ?? ""}
                onChange={(e) => update(i, { ...r, value: e.target.value })}
              />
            </div>
          ) : r.kind === "business_hours" ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1">
                {weekdays.map((d, n) => (
                  <Button
                    key={d}
                    size="xs"
                    variant={r.days.includes(n) ? "default" : "outline"}
                    aria-pressed={r.days.includes(n)}
                    onClick={() =>
                      update(i, {
                        ...r,
                        days: r.days.includes(n) ? r.days.filter((x) => x !== n) : [...r.days, n].sort(),
                      })
                    }
                  >
                    {d}
                  </Button>
                ))}
              </div>
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
        onClick={() =>
          set({ rules: [...rules, { kind: "answer", name: answers[0] ?? "", op: "is", value: "" }] })
        }
      >
        <Icon name="add" />
        Add rule
      </Button>
    </>
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

function WaitForm({ config, onChange }: { config: WaitConfig; onChange: (c: Config) => void }) {
  return (
    <>
      <Field label="Wait">
        <Segmented
          aria-label="Wait"
          value={config.mode}
          onChange={(mode) =>
            onChange(
              mode === "delay"
                ? { mode, amount: 1, unit: "hours" }
                : { mode, time: "09:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            )
          }
          options={[
            { value: "delay", label: "For a while" },
            { value: "until_time", label: "Until a time of day" },
          ]}
        />
      </Field>
      {config.mode === "delay" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="How long">
            <TextInput
              type="number"
              min={1}
              value={config.amount}
              onChange={(e) => onChange({ ...config, amount: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Field>
          <Field label="Unit">
            <SelectField
              value={config.unit}
              onValueChange={(unit) => onChange({ ...config, unit })}
              options={[
                { value: "minutes", label: "Minutes" },
                { value: "hours", label: "Hours" },
                { value: "days", label: "Days" },
              ]}
            />
          </Field>
        </div>
      ) : (
        <Field
          label="Until"
          hint={`Time zone ${config.timezone}. If that time has passed today, it waits for tomorrow.`}
        >
          <TextInput
            type="time"
            value={config.time}
            onChange={(e) => onChange({ ...config, time: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

// ---------------------------------------------------------------- texts with {{variables}}

function TextWithVariables({
  label,
  hint,
  value,
  onChange,
  def,
  options,
  rows = 4,
  max,
  optional,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
  rows?: number;
  max?: number;
  optional?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, at)}${token}${value.slice(el?.selectionEnd ?? at)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  const answers = def.nodes
    .filter((n) => n.type === "ask_question")
    .map((n) => String((n.config as { saveAs?: string }).saveAs ?? ""))
    .filter(Boolean);
  return (
    <Field label={label} hint={hint} optional={optional}>
      {(control) => (
        <div className="flex flex-col gap-1">
          <Textarea
            {...control}
            ref={ref}
            rows={rows}
            value={value}
            maxLength={max}
            onChange={(e) => onChange(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground">
                  <Icon name="add" />
                  Insert detail
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                <DropdownMenuLabel>Contact</DropdownMenuLabel>
                {[
                  ["contact.first_name", "First name"],
                  ["contact.name", "Name"],
                  ["contact.phone", "Phone"],
                  ["contact.email", "Email"],
                  ...(options?.fields ?? []).map((f) => [`contact.${f.key}`, f.label]),
                ].map(([path, name]) => (
                  <DropdownMenuItem key={path} onSelect={() => insert(`{{${path}}}`)}>
                    {name}
                  </DropdownMenuItem>
                ))}
                {answers.length ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Answers</DropdownMenuLabel>
                    {answers.map((a) => (
                      <DropdownMenuItem key={a} onSelect={() => insert(`{{answers.${a}}}`)}>
                        {a}
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => insert("{{trigger.text}}")}>
                  Message that started it
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => insert("{{business.name}}")}>
                  Business name
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => insert("{{chat.assignee}}")}>
                  Assigned team member
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {max ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {value.length}/{max}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </Field>
  );
}
