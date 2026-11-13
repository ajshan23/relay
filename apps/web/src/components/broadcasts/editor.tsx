"use client";

import { Icon, type IconName } from "@relay/ui/components/icon";
import { PageHeader } from "@relay/ui/components/page-header";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Checkbox } from "@relay/ui/ui/checkbox";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Switch } from "@relay/ui/ui/switch";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type Broadcast,
  type BroadcastInput,
  type Estimate,
  type Options,
  useBroadcast,
  useBroadcastActions,
  useOptions,
  type ValueSpec,
} from "./queries";
import { channelNames, weekdays } from "./words";

/*
 * New broadcast (and editing a draft), in five steps: Channel → Audience → Message → Schedule →
 * Review. The channel comes first, like the template samples page: WhatsApp sends approved templates
 * now; SMS and email will add their own message step. Review saves a draft and shows who it reaches,
 * who's skipped and why, and when it will finish, before anything is sent.
 */

type Step = "channel" | "audience" | "message" | "schedule" | "review";
const steps: { id: Step; label: string }[] = [
  { id: "channel", label: "Channel" },
  { id: "audience", label: "Audience" },
  { id: "message", label: "Message" },
  { id: "schedule", label: "Schedule" },
  { id: "review", label: "Review" },
];

const channelCards: { type: string; icon: IconName; text: string; soon?: boolean }[] = [
  {
    type: "whatsapp",
    icon: "whatsapp",
    text: "An approved template, with a photo, video or file if it has one.",
  },
  { type: "sms", icon: "message", text: "A short text message to phone numbers.", soon: true },
  { type: "email", icon: "mail", text: "An email with a subject and a formatted body.", soon: true },
];

type Pace = "auto" | "perDay" | "endBy";

type Form = {
  name: string;
  channelType: string;
  channelAccountId: string;
  templateId: string;
  values: Record<string, ValueSpec>;
  listIds: string[];
  excludeListIds: string[];
  startMode: "now" | "later";
  startAt: string;
  windowOn: boolean;
  days: number[];
  from: string;
  to: string;
  pace: Pace;
  perDay: string;
  endBy: string;
};

/** "2026-11-18T09:00" in the browser's time for a datetime-local input, from an ISO time. */
const localInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function fromBroadcast(b: Broadcast | undefined): Form {
  const s = b?.schedule;
  return {
    name: b?.name ?? "",
    channelType: b?.channelType ?? "whatsapp",
    channelAccountId: b?.channelAccountId ?? "",
    templateId: b?.content.kind === "template" ? b.content.templateId : "",
    values: b?.content.kind === "template" ? b.content.values : {},
    listIds: b?.audience.listIds ?? [],
    excludeListIds: b?.audience.excludeListIds ?? [],
    startMode: s?.startAt ? "later" : "now",
    startAt: localInput(s?.startAt ?? null),
    windowOn: !!s?.window,
    days: s?.window?.days ?? [1, 2, 3, 4, 5, 6, 7],
    from: s?.window?.from ?? "09:00",
    to: s?.window?.to ?? "20:00",
    pace: s?.perDay ? "perDay" : s?.endBy ? "endBy" : "auto",
    perDay: s?.perDay ? String(s.perDay) : "",
    endBy: s?.endBy ? s.endBy.slice(0, 10) : "",
  };
}

function toInput(f: Form): BroadcastInput {
  return {
    name: f.name.trim(),
    channelAccountId: f.channelAccountId,
    content: { kind: "template", templateId: f.templateId, values: f.values },
    audience: { listIds: f.listIds, excludeListIds: f.excludeListIds },
    schedule: {
      startAt: f.startMode === "later" && f.startAt ? new Date(f.startAt).toISOString() : null,
      window: f.windowOn ? { days: f.days, from: f.from, to: f.to } : null,
      perDay: f.pace === "perDay" && Number(f.perDay) > 0 ? Math.floor(Number(f.perDay)) : null,
      endBy: f.pace === "endBy" && f.endBy ? new Date(`${f.endBy}T23:59:00`).toISOString() : null,
    },
  };
}

export function BroadcastEditor({ id }: { id?: string }) {
  const existing = useBroadcast(id ?? "");
  const options = useOptions();
  if (!options.data || (id && !existing.data))
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8 sm:px-8">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  return <Editor initial={fromBroadcast(existing.data?.broadcast)} id={id} options={options.data} />;
}

function Editor({ initial, id: initialId, options }: { initial: Form; id?: string; options: Options }) {
  const router = useRouter();
  const actions = useBroadcastActions();
  const [form, setForm] = useState<Form>(initial);
  const [step, setStep] = useState<Step>(initialId ? "review" : "channel");
  const [id, setId] = useState(initialId);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [checking, setChecking] = useState(false);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const accounts = options.channels.filter((c) => c.type === form.channelType);
  const account = accounts.find((c) => c.id === form.channelAccountId);
  const templates = options.templates.filter((t) => t.channelAccountId === form.channelAccountId);
  const template = templates.find((t) => t.id === form.templateId);

  // One number on the channel: pick it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: set is a stable updater
  useEffect(() => {
    if (!form.channelAccountId && accounts.length === 1 && accounts[0])
      set({ channelAccountId: accounts[0].id });
  }, [accounts, form.channelAccountId]);

  const problems: Record<Step, string | null> = {
    channel: !form.channelAccountId ? "Choose a number." : null,
    audience: !form.listIds.length ? "Choose at least one list." : null,
    message: !template
      ? "Choose an approved template."
      : template.variables.some(
            (v) =>
              !form.values[v] ||
              (form.values[v]?.source === "static" && !(form.values[v] as { text: string }).text.trim()),
          )
        ? "Fill in every detail."
        : !form.name.trim()
          ? "Give the broadcast a name."
          : null,
    schedule:
      form.startMode === "later" && !form.startAt
        ? "Pick when to start."
        : form.windowOn && (!form.days.length || form.from >= form.to)
          ? "Sending hours need at least one day, and must end after they start."
          : form.pace === "perDay" && !(Number(form.perDay) > 0)
            ? "Enter how many per day."
            : form.pace === "endBy" && !form.endBy
              ? "Pick the finish date."
              : null,
    review: null,
  };
  const ready = (s: Step) =>
    steps
      .slice(
        0,
        steps.findIndex((x) => x.id === s),
      )
      .every((x) => !problems[x.id]);

  async function saveDraft() {
    const res = await actions.save.mutateAsync({ id, ...toInput(form) });
    setId(res.broadcast.id);
    if (!initialId) window.history.replaceState(null, "", `/broadcasts/${res.broadcast.id}/edit`);
    return res.broadcast.id;
  }

  async function goReview() {
    setStep("review");
    setChecking(true);
    try {
      const saved = await saveDraft();
      setEstimate((await actions.preview(saved)).estimate);
    } catch (err) {
      notify.error("Couldn't check the audience", {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setChecking(false);
    }
  }

  async function start() {
    try {
      const saved = await saveDraft();
      await actions.act.mutateAsync({ id: saved, action: "start" });
      notify.success(form.startMode === "later" ? "Broadcast scheduled" : "Broadcast starting");
      router.push(`/broadcasts/${saved}`);
    } catch (err) {
      notify.error("Couldn't start it", { description: err instanceof ApiError ? err.message : undefined });
    }
  }

  const index = steps.findIndex((x) => x.id === step);
  const next = steps[index + 1];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 pb-12">
      <PageHeader
        title={initialId ? "Edit broadcast" : "New broadcast"}
        breadcrumb={[{ label: "Broadcasts", href: "/broadcasts" }, { label: form.name || "New broadcast" }]}
      />
      <div className="grid gap-6 px-5 sm:px-8 lg:grid-cols-[200px_1fr]">
        <ol className="flex gap-1 overflow-x-auto lg:flex-col">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                disabled={!ready(s.id)}
                onClick={() => (s.id === "review" ? void goReview() : setStep(s.id))}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
                  step === s.id ? "bg-accent font-medium text-accent-foreground" : "hover:bg-muted",
                )}
              >
                <span
                  className={cn(
                    "inline-flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums",
                    i < index && !problems[s.id] && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {i < index && !problems[s.id] ? <Icon name="check" size="xs" /> : i + 1}
                </span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>

        <Panel padding="lg" className="flex min-w-0 flex-col gap-5">
          {step === "channel" ? (
            <div className="flex flex-col gap-5">
              <Heading
                title="Which channel?"
                text="More channels are on the way; each sends its own kind of message."
              />
              <div className="grid gap-3 sm:grid-cols-3">
                {channelCards.map((card) => {
                  const has = options.channels.some((c) => c.type === card.type);
                  const disabled = card.soon || !has;
                  return (
                    <button
                      key={card.type}
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        set({ channelType: card.type, channelAccountId: "", templateId: "", values: {} })
                      }
                      className={cn(
                        "flex flex-col gap-2 rounded-lg border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
                        form.channelType === card.type && !disabled
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted/50",
                      )}
                    >
                      <span className="flex items-center justify-between">
                        <Icon name={card.icon} />
                        {card.soon ? (
                          <Tag size="sm">Coming soon</Tag>
                        ) : !has ? (
                          <Tag size="sm">Not connected</Tag>
                        ) : null}
                      </span>
                      <span className="font-medium">{channelNames[card.type]}</span>
                      <span className="text-xs text-muted-foreground">{card.text}</span>
                    </button>
                  );
                })}
              </div>
              {accounts.length ? (
                <div className="flex max-w-md flex-col gap-1.5">
                  <span className="text-sm font-medium">Send from</span>
                  <SelectField
                    aria-label="Number"
                    value={form.channelAccountId}
                    onValueChange={(v) => set({ channelAccountId: v, templateId: "", values: {} })}
                    placeholder="Choose a number"
                    options={accounts.map((a) => ({
                      value: a.id,
                      label: `${a.name}${a.phone ? ` · ${a.phone}` : ""}`,
                      disabled: a.status !== "active",
                    }))}
                  />
                  {account ? <AccountHealth account={account} /> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === "audience" ? (
            <div className="flex flex-col gap-5">
              <Heading
                title="Who gets it?"
                text="Everyone in the chosen lists, once each. The list is copied when the broadcast starts, so later changes to it don't affect a broadcast that's running."
              />
              <ListPicker
                label="Send to"
                lists={options.lists}
                value={form.listIds}
                onChange={(listIds) =>
                  set({ listIds, excludeListIds: form.excludeListIds.filter((x) => !listIds.includes(x)) })
                }
              />
              <ListPicker
                label="Leave out (optional)"
                lists={options.lists.filter((l) => !form.listIds.includes(l.id))}
                value={form.excludeListIds}
                onChange={(excludeListIds) => set({ excludeListIds })}
              />
              {!options.lists.length ? (
                <p className="text-sm text-muted-foreground">No lists yet. Make one in Contacts → Lists.</p>
              ) : null}
            </div>
          ) : null}

          {step === "message" ? (
            <div className="flex flex-col gap-5">
              <Heading
                title="What does it say?"
                text="WhatsApp broadcasts send a template Meta approved for this number."
              />
              <div className="flex max-w-md flex-col gap-1.5">
                <label htmlFor="broadcast-name" className="text-sm font-medium">
                  Broadcast name (only your team sees it)
                </label>
                <TextInput
                  id="broadcast-name"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="November skin care offer"
                />
              </div>
              <div className="flex max-w-md flex-col gap-1.5">
                <span className="text-sm font-medium">Template</span>
                <SelectField
                  aria-label="Template"
                  value={form.templateId}
                  onValueChange={(v) => {
                    const t = templates.find((x) => x.id === v);
                    const values: Record<string, ValueSpec> = {};
                    for (const name of t?.variables ?? [])
                      values[name] = /name/.test(name)
                        ? {
                            source: "field",
                            key: name.includes("first") ? "first_name" : "name",
                            fallback: "there",
                          }
                        : { source: "static", text: "" };
                    set({ templateId: v, values });
                  }}
                  placeholder={
                    templates.length ? "Choose a template" : "No approved templates on this number"
                  }
                  options={templates.map((t) => ({
                    value: t.id,
                    label: `${t.name} · ${t.purpose === "marketing" ? "Marketing" : t.purpose === "login" ? "Login" : "Updates"}${t.quality === "RED" ? " · low quality" : ""}`,
                  }))}
                />
              </div>
              {template ? (
                <div className="grid gap-5 md:grid-cols-[1fr_280px]">
                  <div className="flex flex-col gap-3">
                    {template.variables.map((v) => (
                      <ValueField
                        key={v}
                        name={v}
                        value={form.values[v] ?? { source: "static", text: "" }}
                        fields={options.fields}
                        onChange={(spec) => set({ values: { ...form.values, [v]: spec } })}
                      />
                    ))}
                    {!template.variables.length ? (
                      <p className="text-sm text-muted-foreground">
                        This template has no details to fill in.
                      </p>
                    ) : null}
                  </div>
                  <TemplatePreview template={template} values={form.values} fields={options.fields} />
                </div>
              ) : null}
            </div>
          ) : null}

          {step === "schedule" ? (
            <div className="flex flex-col gap-6">
              <Heading
                title="When does it go?"
                text={`Times are in the branch's time zone (${options.timezone}).`}
              />
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Start</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={form.startMode === "now" ? "default" : "outline"}
                    onClick={() => set({ startMode: "now" })}
                  >
                    As soon as I start it
                  </Button>
                  <Button
                    size="sm"
                    variant={form.startMode === "later" ? "default" : "outline"}
                    onClick={() => set({ startMode: "later" })}
                  >
                    Later
                  </Button>
                  {form.startMode === "later" ? (
                    <TextInput
                      type="datetime-local"
                      aria-label="Start at"
                      value={form.startAt}
                      onChange={(e) => set({ startAt: e.target.value })}
                      className="w-60"
                    />
                  ) : null}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <label className="flex items-center justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium">Only send at certain hours</span>
                    <span className="block text-xs text-muted-foreground">
                      Outside them it waits, and carries on when they open again.
                    </span>
                  </span>
                  <Switch
                    checked={form.windowOn}
                    onCheckedChange={(v) => set({ windowOn: v })}
                    aria-label="Only send at certain hours"
                  />
                </label>
                {form.windowOn ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex gap-1">
                      {weekdays.map((d, i) => {
                        const day = i + 1;
                        const on = form.days.includes(day);
                        return (
                          <Button
                            key={d}
                            size="sm"
                            variant={on ? "default" : "outline"}
                            className="w-11 px-0"
                            aria-pressed={on}
                            onClick={() =>
                              set({
                                days: on ? form.days.filter((x) => x !== day) : [...form.days, day].sort(),
                              })
                            }
                          >
                            {d}
                          </Button>
                        );
                      })}
                    </div>
                    <span className="flex items-center gap-2 text-sm">
                      from
                      <TextInput
                        type="time"
                        aria-label="From"
                        value={form.from}
                        onChange={(e) => set({ from: e.target.value })}
                        className="w-28"
                      />
                      to
                      <TextInput
                        type="time"
                        aria-label="To"
                        value={form.to}
                        onChange={(e) => set({ to: e.target.value })}
                        className="w-28"
                      />
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">How fast</span>
                <SelectField
                  aria-label="How fast"
                  value={form.pace}
                  onValueChange={(v) => set({ pace: v as Pace })}
                  options={[
                    { value: "auto", label: "Recommended: up to 75% of the daily limit per day" },
                    { value: "perDay", label: "A set number per day" },
                    { value: "endBy", label: "Spread it to finish by a date" },
                  ]}
                  className="max-w-md"
                />
                {form.pace === "perDay" ? (
                  <TextInput
                    type="number"
                    min={1}
                    aria-label="Per day"
                    value={form.perDay}
                    onChange={(e) => set({ perDay: e.target.value })}
                    className="w-40"
                    placeholder="1000"
                  />
                ) : null}
                {form.pace === "endBy" ? (
                  <TextInput
                    type="date"
                    aria-label="Finish by"
                    value={form.endBy}
                    onChange={(e) => set({ endBy: e.target.value })}
                    className="w-48"
                  />
                ) : null}
                <p className="max-w-xl text-xs text-muted-foreground">
                  WhatsApp limits how many people your business can message first each day
                  {account?.dailyLimit
                    ? ` (yours: ${account.dailyLimit === -1 ? "unlimited" : account.dailyLimit.toLocaleString()})`
                    : ""}
                  . The limit is shared with your chats and other broadcasts, so leaving room avoids hitting
                  it. Messages are spread evenly over the sending hours.
                </p>
              </div>
            </div>
          ) : null}

          {step === "review" ? (
            <ReviewStep
              form={form}
              estimate={estimate}
              checking={checking}
              template={template}
              account={account}
            />
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <span className="text-sm text-destructive">{step !== "review" ? problems[step] : null}</span>
            <div className="flex gap-2">
              {index > 0 ? (
                <Button variant="outline" onClick={() => setStep(steps[index - 1]?.id ?? "channel")}>
                  Back
                </Button>
              ) : null}
              {step === "review" ? (
                <>
                  <Button
                    variant="outline"
                    disabled={actions.save.isPending}
                    onClick={() =>
                      void saveDraft().then(
                        () => notify.success("Draft saved"),
                        (err) =>
                          notify.error("Couldn't save", {
                            description: err instanceof ApiError ? err.message : undefined,
                          }),
                      )
                    }
                  >
                    Save draft
                  </Button>
                  <Button
                    disabled={checking || !estimate?.reach || actions.act.isPending}
                    onClick={() => void start()}
                  >
                    <Icon name="send" />
                    {form.startMode === "later" ? "Schedule broadcast" : "Start broadcast"}
                  </Button>
                </>
              ) : next ? (
                <Button
                  disabled={!!problems[step]}
                  onClick={() => (next.id === "review" ? void goReview() : setStep(next.id))}
                >
                  Next: {next.label}
                </Button>
              ) : null}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Heading({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function AccountHealth({ account }: { account: Options["channels"][number] }) {
  const low = account.quality === "RED";
  return (
    <p className={cn("text-xs", low ? "text-destructive" : "text-muted-foreground")}>
      {low
        ? "This number's quality is low. Broadcasts can't start until it recovers."
        : `Quality ${account.quality?.toLowerCase() ?? "unknown"} · daily limit ${
            account.dailyLimit === -1
              ? "unlimited"
              : account.dailyLimit
                ? `${account.dailyLimit.toLocaleString()} people`
                : "checked when it starts"
          }`}
    </p>
  );
}

function ListPicker({
  label,
  lists,
  value,
  onChange,
}: {
  label: string;
  lists: Options["lists"];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  if (!lists.length) return null;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {lists.map((l) => {
          const on = value.includes(l.id);
          return (
            <label
              key={l.id}
              className={cn(
                "flex items-center gap-3 rounded-md border px-3 py-2 text-sm",
                on && "border-primary bg-primary/5",
              )}
            >
              <Checkbox
                checked={on}
                onCheckedChange={(v) => onChange(v ? [...value, l.id] : value.filter((x) => x !== l.id))}
              />
              <span className="flex-1 truncate">{l.name}</span>
              {l.kind === "smart" ? <Tag size="sm">Smart</Tag> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ValueField({
  name,
  value,
  fields,
  onChange,
}: {
  name: string;
  value: ValueSpec;
  fields: Options["fields"];
  onChange: (v: ValueSpec) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-3">
      <span className="text-sm font-medium">{`{{${name}}}`}</span>
      <div className="flex flex-wrap gap-2">
        <SelectField
          aria-label={`Where ${name} comes from`}
          value={value.source === "static" ? "static" : `field:${value.key}`}
          onValueChange={(v) =>
            onChange(
              v === "static"
                ? { source: "static", text: "" }
                : { source: "field", key: v.slice(6), fallback: "" },
            )
          }
          options={[
            { value: "static", label: "The same text for everyone" },
            ...fields.map((f) => ({ value: `field:${f.key}`, label: `Contact: ${f.label}` })),
          ]}
          className="w-64"
        />
        {value.source === "static" ? (
          <TextInput
            aria-label={`${name} text`}
            value={value.text}
            onChange={(e) => onChange({ source: "static", text: e.target.value })}
            className="min-w-48 flex-1"
          />
        ) : (
          <TextInput
            aria-label={`${name} if empty`}
            value={value.fallback ?? ""}
            onChange={(e) => onChange({ ...value, fallback: e.target.value })}
            placeholder="If empty (otherwise they're skipped)"
            className="min-w-48 flex-1"
          />
        )}
      </div>
    </div>
  );
}

function fill(text: string, values: Record<string, ValueSpec>, fields: Options["fields"]) {
  return text.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, n: string) => {
    const v = values[n];
    if (!v) return `{{${n}}}`;
    if (v.source === "static") return v.text || `{{${n}}}`;
    return `[${fields.find((f) => f.key === v.key)?.label ?? v.key}]`;
  });
}

function TemplatePreview({
  template,
  values,
  fields,
}: {
  template: Options["templates"][number];
  values: Record<string, ValueSpec>;
  fields: Options["fields"];
}) {
  const c = template.content;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">Preview</span>
      <div className="rounded-lg bg-[#e7ffdb] p-3 text-sm text-neutral-900 shadow-sm dark:bg-emerald-950 dark:text-emerald-50">
        {c.header && c.header.kind !== "text" ? (
          <div className="mb-2 flex h-28 items-center justify-center rounded bg-black/10 text-xs">
            {c.header.kind}
          </div>
        ) : c.header?.text ? (
          <p className="mb-1 font-semibold">{fill(c.header.text, values, fields)}</p>
        ) : null}
        <p className="whitespace-pre-wrap">{fill(c.body, values, fields)}</p>
        {c.footer ? <p className="mt-1 text-xs opacity-60">{c.footer}</p> : null}
      </div>
    </div>
  );
}

function ReviewStep({
  form,
  estimate,
  checking,
  template,
  account,
}: {
  form: Form;
  estimate: Estimate | null;
  checking: boolean;
  template: Options["templates"][number] | undefined;
  account: Options["channels"][number] | undefined;
}) {
  const finish = useMemo(() => {
    if (!estimate) return null;
    if (form.pace === "endBy" && form.endBy) return new Date(form.endBy).toLocaleDateString();
    return estimate.sendingDays <= 1 ? "the same day" : `about ${estimate.sendingDays} sending days`;
  }, [estimate, form.pace, form.endBy]);
  if (checking || !estimate)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  const skipped = estimate.skipped.noAddress + estimate.skipped.optedOut + estimate.skipped.duplicates;
  return (
    <div className="flex flex-col gap-5">
      <Heading title="Check and start" text="Nothing is sent until you start it." />
      <dl className="grid gap-3 sm:grid-cols-3">
        <Fact label="Will receive it" value={estimate.reach.toLocaleString()} />
        <Fact label="Skipped" value={skipped.toLocaleString()} />
        <Fact label="Finishes" value={finish ?? "—"} />
      </dl>
      {skipped ? (
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {estimate.skipped.optedOut ? (
            <li>{estimate.skipped.optedOut} opted out of marketing on this number</li>
          ) : null}
          {estimate.skipped.noAddress ? <li>{estimate.skipped.noAddress} have no phone number</li> : null}
          {estimate.skipped.duplicates ? (
            <li>{estimate.skipped.duplicates} share a number with someone else in the lists (sent once)</li>
          ) : null}
        </ul>
      ) : null}
      {estimate.usNumbers ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          {estimate.usNumbers} US numbers are in the audience. Meta doesn't deliver marketing templates to US
          numbers; they'll fail.
        </p>
      ) : null}
      <div className="grid gap-2 text-sm">
        <Row label="From">
          {account ? `${account.name}${account.phone ? ` · ${account.phone}` : ""}` : "—"}
        </Row>
        <Row label="Template">{template?.name ?? "—"}</Row>
        <Row label="Starts">
          {form.startMode === "later" && form.startAt
            ? new Date(form.startAt).toLocaleString()
            : "Right away"}
        </Row>
        <Row label="Sending hours">
          {form.windowOn
            ? `${form.days.map((d) => weekdays[d - 1]).join(", ")}, ${form.from}–${form.to}`
            : "Any time"}
        </Row>
        <Row label="Per day">
          {estimate.perDay
            ? `Up to ${estimate.perDay.toLocaleString()}`
            : form.pace === "endBy"
              ? "Spread to finish on time"
              : "No limit"}
        </Row>
      </div>
      <p className="text-xs text-muted-foreground">
        It pauses by itself if Meta pauses the template, the number's quality drops, or many messages start
        failing. You can pause or stop it at any time.
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
