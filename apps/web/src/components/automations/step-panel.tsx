"use client";

import {
  type AskLocationConfig,
  type AskQuestionConfig,
  type AutomationDefinition,
  type Issue,
  nodeSpec,
  TRIGGER_NODE_ID,
  type Trigger,
  type WaitConfig,
} from "@relay/core/automations";
import { Segmented, SwitchRow } from "@relay/ui/components/choice";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { stepLook, stepSummary } from "./canvas";
import { type ChosenLocation, LocationPicker } from "./location-picker";
import { handlesOf, nodeById } from "./ops";
import type { EditorOptions } from "./queries";
import { BranchForm, ConditionForm } from "./rules-editor";
import { TextWithVariables } from "./text-with-variables";
import { UtilityForm } from "./utility-form";
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
  const mine = p.issues.filter((i) => i.nodeId === p.nodeId);
  const config = (node?.config ?? {}) as Config;
  const set = (patch: Config) => p.onConfig({ ...config, ...patch });

  return (
    <aside className="flex h-full w-full flex-col border-l bg-background" aria-label="Step settings">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <span className="inline-flex size-7 items-center justify-center rounded-md bg-muted">
          <Icon name={isTrigger ? "zap" : stepLook(node ?? null).icon} size="sm" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">
            {isTrigger ? "Trigger" : stepLook(node ?? null).title}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {isTrigger ? "What starts this automation" : stepLook(node ?? null).description}
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
          ) : node?.type === "send_link" ? (
            <LinkForm config={config} set={set} def={p.def} options={p.options} />
          ) : node?.type === "ask_location" ? (
            <AskLocationForm
              config={config as unknown as AskLocationConfig}
              set={set}
              def={p.def}
              options={p.options}
            />
          ) : node?.type === "send_location" ? (
            <SendLocationForm config={config} set={set} />
          ) : node?.type === "condition" ? (
            <ConditionForm config={config} set={set} def={p.def} options={p.options} />
          ) : node?.type === "branch" ? (
            <BranchForm config={config} set={set} def={p.def} options={p.options} />
          ) : node?.type === "utility" ? (
            <UtilityForm config={config} set={set} def={p.def} options={p.options} />
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

/** A photo, video or file for a send step: upload one, or remove it. */
function MediaPicker({
  media,
  onChange,
  label,
  accept,
  hint,
}: {
  media: { kind: string; fileId: string; name?: string } | null;
  onChange: (media: { kind: string; fileId: string; name?: string } | null) => void;
  label: string;
  accept: string;
  hint?: string;
}) {
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
      onChange({ kind: upload.kind, fileId: upload.fileId, name: upload.fileName });
    } catch (err) {
      notify.error("File not added", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setUploading(false);
    }
  };
  return (
    <Field label={label} optional hint={hint}>
      {() =>
        media ? (
          <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Icon
              name={media.kind === "image" ? "image" : media.kind === "video" ? "video" : "file"}
              size="sm"
            />
            <span className="min-w-0 flex-1 truncate">{media.name ?? media.kind}</span>
            <Button variant="ghost" size="xs" onClick={() => onChange(null)}>
              Remove
            </Button>
          </div>
        ) : (
          <div>
            <input
              ref={input}
              type="file"
              className="hidden"
              accept={accept}
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
  );
}

const fileTypes = "image/jpeg,image/png,video/mp4,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt";

const waitTimes = [
  [5, "5 minutes"],
  [15, "15 minutes"],
  [60, "1 hour"],
  [180, "3 hours"],
  [720, "12 hours"],
  [1440, "1 day"],
  [4320, "3 days"],
  [10080, "7 days"],
].map(([v, l]) => ({ value: String(v), label: String(l) }));

function SendMessageForm({ config, set, def, options }: FormProps) {
  const media = config.media as { kind: string; fileId: string; name?: string } | null;
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
      <MediaPicker
        label="Photo, video or file"
        media={media}
        onChange={(media) => set({ media })}
        accept={fileTypes}
      />
      <WaitForReply config={config} set={set} buttons={[]} />
      <p className="text-xs text-muted-foreground">
        Free-form messages only go out within 24 hours of the customer's last message. Use a template
        otherwise.
      </p>
    </>
  );
}

/** "Send link button": text, the button and its link, an optional file on top, and waiting for a tap. */
function LinkForm({ config, set, def, options }: FormProps) {
  const media = config.media as { kind: string; fileId: string; name?: string } | null;
  const buttonText = String(config.buttonText ?? "");
  const waiting = !!config.waitForTap;
  return (
    <>
      <TextWithVariables
        label="Message"
        value={String(config.text ?? "")}
        onChange={(text) => set({ text })}
        def={def}
        options={options}
        max={1024}
      />
      <Field label="Button text" hint={`${buttonText.length}/20 · What the button says, like “Book now”.`}>
        <TextInput value={buttonText} maxLength={20} onChange={(e) => set({ buttonText: e.target.value })} />
      </Field>
      <TextWithVariables
        label="Link"
        hint="Starts with https://. Details you insert are made safe for links."
        value={String(config.url ?? "")}
        onChange={(url) => set({ url: url.replace(/\s+/g, "") })}
        def={def}
        options={options}
        rows={2}
      />
      <MediaPicker
        label="Picture, video or file on top"
        media={media}
        onChange={(media) => set({ media })}
        accept="image/jpeg,image/png,video/mp4,application/pdf"
      />
      <Field label="Footer" optional hint="Small grey text under the message.">
        <TextInput
          value={String(config.footer ?? "")}
          maxLength={60}
          onChange={(e) => set({ footer: e.target.value })}
        />
      </Field>
      <section className="flex flex-col gap-3 rounded-md border p-3">
        <SwitchRow
          label="Wait for a tap"
          description={
            waiting
              ? "Takes “Tapped” when they open the link, or “Not tapped” after the time below."
              : "Off: the automation goes straight on. Taps still show in the run's history."
          }
          checked={waiting}
          onCheckedChange={(waitForTap) => set({ waitForTap, timeoutMinutes: config.timeoutMinutes ?? 1440 })}
        />
        {waiting ? (
          <Field label="Wait up to">
            <SelectField
              value={String(config.timeoutMinutes ?? 1440)}
              onValueChange={(v) => set({ timeoutMinutes: Number(v) })}
              options={waitTimes}
            />
          </Field>
        ) : null}
      </section>
      <p className="text-xs text-muted-foreground">
        The button opens a short Relay link that counts the tap and goes straight on to your page.
      </p>
    </>
  );
}

/** "Ask for location": the question, where the pin is saved, and what a typed answer does. */
function AskLocationForm({
  config,
  set,
  def,
  options,
}: Omit<FormProps, "config"> & { config: AskLocationConfig }) {
  const name = config.saveAs || "location";
  return (
    <>
      <TextWithVariables
        label="Question"
        hint="WhatsApp shows a “Send location” button under it."
        value={config.text}
        onChange={(text) => set({ text })}
        def={def}
        options={options}
        max={1024}
      />
      <Field
        label="Save the location as"
        hint={`{{answers.${name}}} is the address; {{answers.${name}.map_link}} opens it in Maps.`}
      >
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
      <section className="rounded-md border p-3">
        <SwitchRow
          label="Also accept a typed address"
          description={
            config.acceptTyped
              ? "A typed address counts as their answer (saved without a map pin)."
              : "Only a shared pin counts. Typed text gets the message below, then “Didn't share”."
          }
          checked={config.acceptTyped}
          onCheckedChange={(acceptTyped) => set({ acceptTyped })}
        />
      </section>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ask again" hint="Times, when they don't share it.">
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
            options={waitTimes}
          />
        </Field>
      </div>
      <TextWithVariables
        label="When they don't share it"
        value={config.retryText}
        onChange={(retryText) => set({ retryText })}
        def={def}
        options={options}
        rows={2}
      />
    </>
  );
}

/** "Send location": the pin, chosen on a map, with its name and address. */
function SendLocationForm({ config, set }: Pick<FormProps, "config" | "set">) {
  const [picking, setPicking] = useState(false);
  const latitude = Number(config.latitude ?? 0);
  const longitude = Number(config.longitude ?? 0);
  const chosen = !(latitude === 0 && longitude === 0);
  const value: ChosenLocation | null = chosen
    ? { latitude, longitude, name: String(config.name ?? ""), address: String(config.address ?? "") }
    : null;
  return (
    <>
      <Field label="Location">
        {() =>
          chosen ? (
            <div className="flex items-start gap-3 rounded-md border px-3 py-2.5">
              <Icon name="location" size="sm" className="mt-0.5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{value?.name || "Pin without a name"}</p>
                {value?.address ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{value.address}</p>
                ) : null}
                <a
                  href={`https://www.google.com/maps?q=${latitude},${longitude}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums underline-offset-2 hover:underline"
                >
                  {latitude}, {longitude}
                  <Icon name="external" size="xs" />
                </a>
              </div>
              <Button variant="outline" size="xs" onClick={() => setPicking(true)}>
                Change
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
              <Icon name="location" />
              Choose on map
            </Button>
          )
        }
      </Field>
      {chosen ? (
        <>
          <Field label="Name" optional hint="Shown in bold on the pin.">
            <TextInput
              value={String(config.name ?? "")}
              maxLength={100}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="Address" optional>
            <TextInput
              value={String(config.address ?? "")}
              maxLength={300}
              onChange={(e) => set({ address: e.target.value })}
            />
          </Field>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        They get a map pin they can open in their maps app for directions.
      </p>
      <LocationPicker
        open={picking}
        onOpenChange={setPicking}
        value={value}
        onChoose={(l) =>
          set({ latitude: l.latitude, longitude: l.longitude, name: l.name, address: l.address })
        }
      />
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
          onValueChange={(templateId) =>
            set({
              templateId,
              values: {},
              replyButtons: templates.find((t) => t.id === templateId)?.replyButtons ?? [],
            })
          }
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
      <WaitForReply
        config={config}
        set={set}
        buttons={chosen?.replyButtons ?? []}
        hint={
          chosen?.replyButtons.length
            ? "Each quick-reply button gets its own way, plus one for anything else they write."
            : undefined
        }
      />
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
            options={waitTimes}
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

/** "Wait for a reply" on a send step: the exits become Replied / No reply (and template buttons). */
function WaitForReply({
  config,
  set,
  buttons,
  hint,
}: {
  config: Config;
  set: (patch: Config) => void;
  buttons: { index: number; title: string }[];
  hint?: string;
}) {
  const on = !!config.waitForReply;
  return (
    <section className="flex flex-col gap-3 rounded-md border p-3">
      <SwitchRow
        label="Wait for a reply"
        description={
          on
            ? (hint ?? "Goes on when they reply, or takes “No reply” after the time below.")
            : "Off: the automation goes straight on after sending."
        }
        checked={on}
        onCheckedChange={(waitForReply) =>
          set({ waitForReply, replyButtons: buttons, timeoutMinutes: config.timeoutMinutes ?? 1440 })
        }
      />
      {on ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Wait up to">
            <SelectField
              value={String(config.timeoutMinutes ?? 1440)}
              onValueChange={(v) => set({ timeoutMinutes: Number(v) })}
              options={waitTimes}
            />
          </Field>
          <Field label="Save the reply as" optional>
            <TextInput
              value={String(config.saveAs ?? "")}
              placeholder="reply"
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
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- logic

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
