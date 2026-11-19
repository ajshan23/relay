"use client";

import {
  type AgentToolSave,
  chatTemplateValues,
  type HttpMethod,
  type HttpToolConfig,
  httpMethods,
  type McpServerTool,
  type McpToolConfig,
  type ToolInput,
} from "@relay/core/agent-tools";
import { CheckboxRow, SwitchRow } from "@relay/ui/components/choice";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { ModalActions } from "@relay/ui/components/modal";
import { Panel, Section } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { SidePanel } from "@relay/ui/components/side-panel";
import { Tag } from "@relay/ui/components/tag";
import { TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Switch } from "@relay/ui/ui/switch";
import { useState } from "react";
import { errorText } from "./agents-page";
import {
  type Agent,
  type AgentToolRow,
  type SecretInput,
  type ToolCallRow,
  type ToolTestResult,
  useToolActions,
  useTools,
} from "./queries";

/*
 * Tools: the business's own system, for the agent to use. An API call (one URL, the details the agent
 * asks the customer for, a key) or an MCP server (its tools, each allowed or not). Changes ask the
 * customer to tap Yes first. Recent calls show what happened, for when something goes wrong.
 */

type Editing = { kind: "http" | "mcp"; tool?: AgentToolRow } | null;

export function ToolsView({ agent }: { agent: Agent }) {
  const q = useTools(agent.id);
  const [editing, setEditing] = useState<Editing>(null);
  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.isError)
    return (
      <EmptyState
        icon={<Icon name="alert" />}
        title="Couldn't load tools"
        description={errorText(q.error)}
        action={<Button onClick={() => q.refetch()}>Try again</Button>}
      />
    );
  const { tools, calls, limits, ready, canManage } = q.data;
  const full = tools.length >= limits.perAgent;
  const addButtons = canManage ? (
    <div className="flex flex-wrap gap-2">
      <Button disabled={!ready || full} onClick={() => setEditing({ kind: "http" })}>
        <Icon name="add" size="sm" /> Add API call
      </Button>
      <Button variant="outline" disabled={!ready || full} onClick={() => setEditing({ kind: "mcp" })}>
        <Icon name="integrations" size="sm" /> Connect MCP server
      </Button>
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-8">
      {!ready ? (
        <Panel className="flex items-start gap-3 border-warning bg-warning-soft text-[13px]">
          <Icon name="warning" size="sm" className="mt-0.5 text-warning" />
          <span>Tools can't be added on this server yet: it needs a key to keep your tools' keys safe.</span>
        </Panel>
      ) : null}
      {tools.length ? (
        <Section
          title="Your tools"
          description={`${agent.name} uses these when a customer's question needs them.`}
          actions={addButtons}
        >
          <ToolList agentId={agent.id} tools={tools} canManage={canManage} onEdit={setEditing} />
        </Section>
      ) : (
        <EmptyState
          icon={<Icon name="integrations" />}
          title={`Connect ${agent.name} to your system`}
          description={`Let ${agent.name} check an order, look up stock or book a table, using your own system. Changes always ask the customer to tap Yes first.`}
          action={addButtons ?? undefined}
        />
      )}
      <Section title="Recent calls" description="The last 50 times a tool was used, in chats and in Try.">
        <CallList calls={calls} />
      </Section>
      {editing?.kind === "http" ? (
        <HttpToolPanel agent={agent} tool={editing.tool} onClose={() => setEditing(null)} />
      ) : null}
      {editing?.kind === "mcp" ? (
        <McpToolPanel agent={agent} tool={editing.tool} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

function toolSummary(t: AgentToolRow) {
  if (t.kind === "http") {
    const c = t.config as HttpToolConfig;
    return `${c.method} ${c.url}`;
  }
  const c = t.config as McpToolConfig;
  const allowed = c.tools.filter((x) => x.allowed).length;
  return `${c.url} · ${allowed} of ${c.tools.length} tools allowed`;
}

const asksFirst = (t: AgentToolRow) =>
  t.kind === "http" ? t.confirm : (t.config as McpToolConfig).tools.some((x) => x.allowed && x.confirm);

function ToolList({
  agentId,
  tools,
  canManage,
  onEdit,
}: {
  agentId: string;
  tools: AgentToolRow[];
  canManage: boolean;
  onEdit: (e: Editing) => void;
}) {
  const { setEnabled, remove } = useToolActions(agentId);
  const [confirm, confirmDialog] = useConfirm();
  return (
    <Panel padding="none">
      {confirmDialog}
      <ul className="divide-y">
        {tools.map((t) => (
          <li key={t.id} className="flex items-start gap-3 px-4 py-3">
            <Icon
              name={t.kind === "http" ? "link" : "integrations"}
              size="sm"
              className="mt-0.5 text-muted-foreground"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t.title}</span>
                <Tag size="sm">{t.kind === "http" ? "API call" : "MCP server"}</Tag>
                {asksFirst(t) ? (
                  <Tag size="sm" tone="primary">
                    Asks the customer first
                  </Tag>
                ) : null}
                {t.lastTestOk === true ? (
                  <Tag size="sm" tone="good">
                    Test passed
                  </Tag>
                ) : t.lastTestOk === false ? (
                  <Tag size="sm" tone="danger">
                    Last test failed
                  </Tag>
                ) : null}
              </div>
              <span className="truncate font-mono text-[12px] text-muted-foreground">{toolSummary(t)}</span>
              {t.description ? (
                <span className="line-clamp-2 text-[13px] text-muted-foreground">{t.description}</span>
              ) : null}
            </div>
            {canManage ? (
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  aria-label={t.enabled ? `Turn ${t.title} off` : `Turn ${t.title} on`}
                  checked={t.enabled}
                  disabled={setEnabled.isPending}
                  onCheckedChange={(enabled) =>
                    setEnabled.mutate(
                      { id: t.id, enabled },
                      { onError: (err) => notify.error("Not changed", { description: errorText(err) }) },
                    )
                  }
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${t.title}`}
                  onClick={() => onEdit({ kind: t.kind, tool: t })}
                >
                  <Icon name="edit" size="sm" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${t.title}`}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Delete ${t.title}?`,
                        description: "Your agent stops using it straight away. Its saved key is deleted too.",
                        confirmLabel: "Delete",
                        tone: "danger",
                      })
                    )
                      remove.mutate(t.id, {
                        onError: (err) => notify.error("Not deleted", { description: errorText(err) }),
                      });
                  }}
                >
                  <Icon name="delete" size="sm" />
                </Button>
              </div>
            ) : (
              <Tag size="sm" tone={t.enabled ? "good" : "plain"}>
                {t.enabled ? "On" : "Off"}
              </Tag>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const callLook: Record<
  ToolCallRow["status"],
  { label: string; tone: "good" | "danger" | "plain" | "warning" }
> = {
  ok: { label: "Worked", tone: "good" },
  error: { label: "Failed", tone: "danger" },
  declined: { label: "Customer said No", tone: "plain" },
  not_sent: { label: "Not sent (Try)", tone: "warning" },
};

function CallList({ calls }: { calls: ToolCallRow[] }) {
  if (!calls.length)
    return (
      <p className="px-1 text-[13px] text-muted-foreground">No calls yet. Try your agent to see them here.</p>
    );
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Panel padding="none">
      <ul className="divide-y">
        {calls.map((c) => (
          <li key={c.id} className="flex flex-col gap-1 px-4 py-2.5 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{c.title ?? c.name}</span>
              <Tag size="sm" tone={callLook[c.status].tone}>
                {callLook[c.status].label}
              </Tag>
              <Tag size="sm">{c.mode === "test" ? "Try" : "Chat"}</Tag>
              <span className="ml-auto text-muted-foreground">
                {[
                  c.httpStatus ? `HTTP ${c.httpStatus}` : null,
                  c.ms != null ? `${c.ms} ms` : null,
                  when.format(new Date(c.createdAt)),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {c.error ? <span className="break-words text-destructive">{c.error}</span> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------------ the key

function KeyFields({
  tool,
  header,
  setHeader,
  value,
  setValue,
  removed,
  setRemoved,
}: {
  tool?: AgentToolRow;
  header: string;
  setHeader: (v: string) => void;
  value: string;
  setValue: (v: string) => void;
  removed: boolean;
  setRemoved: (v: boolean) => void;
}) {
  const saved = tool?.hasSecret && !removed;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
        <Field label="Header" hint="Usually Authorization.">
          <TextInput value={header} maxLength={100} onChange={(e) => setHeader(e.target.value)} />
        </Field>
        <Field
          label="Key"
          optional
          hint={
            saved
              ? `Saved key ending ${tool?.secretHint}. Type a new one to replace it.`
              : "Kept encrypted. Never shown again."
          }
        >
          <TextInput
            type="password"
            autoComplete="off"
            placeholder={saved ? "••••••••" : "Bearer sk_live_…"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      </div>
      {saved ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => setRemoved(true)}
        >
          Remove the saved key
        </Button>
      ) : null}
    </div>
  );
}

function secretOf(header: string, value: string, removed: boolean): SecretInput {
  if (value.trim()) return { header: header.trim() || "Authorization", value: value.trim() };
  return removed ? null : undefined;
}

// ------------------------------------------------------------------ API call

const methodOptions = httpMethods.map((m) => ({ value: m, label: m }));
const typeOptions = [
  { value: "text" as const, label: "Text" },
  { value: "number" as const, label: "Number" },
  { value: "boolean" as const, label: "Yes / no" },
];

type Pair = { key: string; value: string };

function PairRows({
  label,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and are edited in place
        <div key={i} className="flex items-center gap-2">
          <TextInput
            aria-label={`${label} name`}
            className="w-40 font-mono text-[13px]"
            placeholder={keyPlaceholder}
            value={r.key}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
          />
          <TextInput
            aria-label={`${label} value`}
            className="min-w-0 flex-1 font-mono text-[13px]"
            placeholder={valuePlaceholder}
            value={r.value}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Remove"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <Icon name="close" size="sm" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Icon name="add" size="sm" /> Add
      </Button>
    </div>
  );
}

function ValueChips({ inputs }: { inputs: ToolInput[] }) {
  const chips = [
    ...inputs
      .filter((i) => i.key)
      .map((i) => ({ token: `{{input.${i.key}}}`, label: i.description || i.key })),
    ...chatTemplateValues,
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-muted-foreground">
        Values you can put in the address, headers and body (tap to copy):
      </span>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.token}
            type="button"
            title={c.label}
            className="rounded-md border bg-muted px-2 py-0.5 font-mono text-[12px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => {
              void navigator.clipboard?.writeText(c.token);
              notify.success(`Copied ${c.token}`);
            }}
          >
            {c.token}
          </button>
        ))}
      </div>
    </div>
  );
}

function HttpToolPanel({ agent, tool, onClose }: { agent: Agent; tool?: AgentToolRow; onClose: () => void }) {
  const { save, test } = useToolActions(agent.id);
  const start = (tool?.config as HttpToolConfig | undefined) ?? null;
  const [title, setTitle] = useState(tool?.title ?? "");
  const [description, setDescription] = useState(tool?.description ?? "");
  const [method, setMethod] = useState<HttpMethod>(start?.method ?? "GET");
  const [url, setUrl] = useState(start?.url ?? "https://");
  const [inputs, setInputs] = useState<ToolInput[]>(start?.inputs ?? []);
  const [query, setQuery] = useState<Pair[]>(start?.query ?? []);
  const [headers, setHeaders] = useState<Pair[]>(start?.headers ?? []);
  const [body, setBody] = useState(start?.body ?? "");
  const [pick, setPick] = useState<string[]>(start?.pick ?? []);
  const [confirm, setConfirm] = useState(tool ? tool.confirm : false);
  const [confirmTouched, setConfirmTouched] = useState(!!tool);
  const [keyHeader, setKeyHeader] = useState("Authorization");
  const [keyValue, setKeyValue] = useState("");
  const [keyRemoved, setKeyRemoved] = useState(false);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ToolTestResult | null>(null);

  const config: HttpToolConfig = {
    method,
    url: url.trim(),
    query: query.filter((q) => q.key.trim()),
    headers: headers.filter((h) => h.key.trim()),
    body: method === "GET" ? "" : body,
    inputs: inputs.filter((i) => i.key.trim()),
    pick,
  };
  const changesThings = method !== "GET";
  const asks = confirmTouched ? confirm : changesThings;

  const sampleValues = () =>
    Object.fromEntries(
      config.inputs.map((i) => {
        const raw = sample[i.key] ?? "";
        return [i.key, i.type === "number" ? Number(raw) : i.type === "boolean" ? raw === "yes" : raw];
      }),
    );

  const paths = result?.ok ? result.paths : [];
  const ticked = (p: string) => !pick.length || pick.includes(p);
  const toggle = (p: string, on: boolean) => {
    const current = pick.length ? pick : paths;
    const next = on ? [...new Set([...current, p])] : current.filter((x) => x !== p);
    setPick(next.length === paths.length ? [] : next);
  };

  const submit = () => {
    const payload: AgentToolSave & { id?: string } = {
      ...(tool ? { id: tool.id } : {}),
      kind: "http",
      title: title.trim(),
      description: description.trim(),
      enabled: tool?.enabled ?? true,
      confirm: asks,
      config,
      ...(secretOf(keyHeader, keyValue, keyRemoved) !== undefined
        ? { secret: secretOf(keyHeader, keyValue, keyRemoved) }
        : {}),
    };
    save.mutate(payload, {
      onSuccess: () => {
        notify.success(tool ? "Saved" : `${agent.name} can use ${title.trim()} now`);
        onClose();
      },
      onError: (err) => notify.error("Not saved", { description: errorText(err) }),
    });
  };

  return (
    <SidePanel
      open
      onOpenChange={(open) => (open ? null : onClose())}
      width="lg"
      title={tool ? `Edit ${tool.title}` : "Add an API call"}
      description="One request to your system, e.g. look up an order or create a booking."
      footer={
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              save.isPending ||
              title.trim().length < 2 ||
              description.trim().length < 5 ||
              !/^https?:\/\/\S+/.test(url)
            }
            onClick={submit}
          >
            {save.isPending ? "Saving…" : tool ? "Save" : "Add tool"}
          </Button>
        </ModalActions>
      }
    >
      <div className="flex flex-col gap-7">
        <div className="flex flex-col gap-3">
          <Field label="Name" required>
            <TextInput
              placeholder="Check order status"
              maxLength={60}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="When to use it" required hint={`${agent.name} reads this to decide when to call it.`}>
            <TextArea
              placeholder="When a customer asks where their order is or when it will arrive."
              minRows={2}
              maxLength={1000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">What {agent.name} asks the customer for</h3>
          {inputs.map((i, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and are edited in place
            <div key={n} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1.4fr_auto]">
              <TextInput
                aria-label="Key"
                className="font-mono text-[13px]"
                placeholder="order_number"
                value={i.key}
                onChange={(e) =>
                  setInputs(
                    inputs.map((x, j) =>
                      j === n ? { ...x, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") } : x,
                    ),
                  )
                }
              />
              <TextInput
                aria-label="What it is"
                placeholder="The order number, e.g. 1001"
                value={i.description}
                onChange={(e) =>
                  setInputs(inputs.map((x, j) => (j === n ? { ...x, description: e.target.value } : x)))
                }
              />
              <div className="flex items-center gap-2">
                <SelectField
                  aria-label="Type"
                  size="sm"
                  options={typeOptions}
                  value={i.type}
                  onValueChange={(type) => setInputs(inputs.map((x, j) => (j === n ? { ...x, type } : x)))}
                />
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Remove"
                  onClick={() => setInputs(inputs.filter((_, j) => j !== n))}
                >
                  <Icon name="close" size="sm" />
                </Button>
              </div>
              <CheckboxRow
                className="sm:col-span-3"
                label="Must have"
                description={`${agent.name} asks for it before calling.`}
                checked={i.required}
                onCheckedChange={(required) =>
                  setInputs(inputs.map((x, j) => (j === n ? { ...x, required } : x)))
                }
              />
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setInputs([...inputs, { key: "", description: "", type: "text", required: true }])}
          >
            <Icon name="add" size="sm" /> Add a detail
          </Button>
          <p className="text-[13px] text-muted-foreground">
            The customer's phone and name are filled in from the chat. {agent.name} can't change them, so
            nobody can look up someone else's order.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">The request</h3>
          <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
            <Field label="Method">
              <SelectField options={methodOptions} value={method} onValueChange={setMethod} />
            </Field>
            <Field label="Address">
              <TextInput
                className="font-mono text-[13px]"
                inputMode="url"
                placeholder="https://shop.example.com/api/orders/{{input.order_number}}"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
          </div>
          <ValueChips inputs={config.inputs} />
          <PairRows
            label="Query"
            rows={query}
            onChange={setQuery}
            keyPlaceholder="phone"
            valuePlaceholder="{{contact.phone}}"
          />
          <PairRows
            label="Headers"
            rows={headers}
            onChange={setHeaders}
            keyPlaceholder="X-Store"
            valuePlaceholder="dubai"
          />
          {method !== "GET" ? (
            <Field
              label="Body (JSON)"
              hint='Put values in quotes for text: "{{input.name}}"; numbers without.'
            >
              <TextArea
                className="font-mono text-[13px]"
                minRows={4}
                placeholder={'{\n  "people": {{input.people}},\n  "phone": "{{contact.phone}}"\n}'}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Key</h3>
          <KeyFields
            tool={tool}
            header={keyHeader}
            setHeader={setKeyHeader}
            value={keyValue}
            setValue={setKeyValue}
            removed={keyRemoved}
            setRemoved={setKeyRemoved}
          />
        </div>

        <SwitchRow
          label="Ask the customer to tap Yes first"
          description={
            changesThings
              ? `Recommended: this changes something. ${agent.name} sends what it's about to do with Yes / No buttons and only calls after Yes.`
              : `${agent.name} sends what it's about to do with Yes / No buttons and only calls after Yes.`
          }
          checked={asks}
          onCheckedChange={(v) => {
            setConfirmTouched(true);
            setConfirm(v);
          }}
        />

        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <h3 className="text-sm font-semibold">Test it</h3>
          <p className="text-[13px] text-muted-foreground">
            Really calls your system with these values
            {changesThings ? ", so it may create or change something" : ""}. The test customer's phone is
            +971500000000.
          </p>
          {config.inputs.map((i) => (
            <Field key={i.key} label={i.description || i.key}>
              <TextInput
                className="font-mono text-[13px]"
                placeholder={i.type === "boolean" ? "yes or no" : i.type === "number" ? "2" : "1001"}
                value={sample[i.key] ?? ""}
                onChange={(e) => setSample({ ...sample, [i.key]: e.target.value })}
              />
            </Field>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={test.isPending || !/^https?:\/\/\S+/.test(url)}
            onClick={() =>
              test.mutate(
                {
                  config,
                  values: sampleValues(),
                  ...(tool ? { toolId: tool.id } : {}),
                  ...(secretOf(keyHeader, keyValue, keyRemoved) !== undefined
                    ? { secret: secretOf(keyHeader, keyValue, keyRemoved) }
                    : {}),
                },
                {
                  onSuccess: setResult,
                  onError: (err) => notify.error("Test didn't run", { description: errorText(err) }),
                },
              )
            }
          >
            <Icon name="play" size="sm" /> {test.isPending ? "Calling…" : "Run test"}
          </Button>
          {result ? <TestResult result={result} ticked={ticked} toggle={toggle} name={agent.name} /> : null}
        </div>
      </div>
    </SidePanel>
  );
}

function preview(v: unknown) {
  const s = JSON.stringify(v, null, 2) ?? "null";
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
}

function valueAt(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    const arr = part.endsWith("[]");
    const key = arr ? part.slice(0, -2) : part;
    if (key) cur = (cur as Record<string, unknown> | null)?.[key];
    if (arr) cur = Array.isArray(cur) ? cur[0] : undefined;
  }
  return cur;
}

function TestResult({
  result,
  ticked,
  toggle,
  name,
}: {
  result: ToolTestResult;
  ticked: (p: string) => boolean;
  toggle: (p: string, on: boolean) => void;
  name: string;
}) {
  if (!result.ok)
    return (
      <div className="flex flex-col gap-2">
        <Tag tone="danger" size="sm" className="self-start">
          Didn't work
        </Tag>
        <p className="break-words text-[13px] text-destructive">{result.error}</p>
        {result.request ? (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 font-mono text-[12px]">
            {result.request.method} {result.request.url}
          </pre>
        ) : null}
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Tag tone="good" size="sm">
          Worked
        </Tag>
        <span className="text-muted-foreground">
          HTTP {result.status} · {result.ms} ms
        </span>
      </div>
      {result.paths.length ? (
        <div className="flex flex-col">
          <span className="text-sm font-medium">What {name} may see</span>
          <span className="text-[13px] text-muted-foreground">
            Untick anything private or not useful; it's removed before {name} sees the answer.
          </span>
          <div className="mt-1 flex flex-col">
            {result.paths.map((p) => (
              <CheckboxRow
                key={p}
                label={<span className="font-mono text-[13px]">{p}</span>}
                description={
                  <span className="font-mono">
                    {String(JSON.stringify(valueAt(result.answer, p)) ?? "").slice(0, 80)}
                  </span>
                }
                checked={ticked(p)}
                onCheckedChange={(on) => toggle(p, on)}
              />
            ))}
          </div>
        </div>
      ) : (
        <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 font-mono text-[12px]">
          {preview(result.answer)}
        </pre>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ MCP server

function McpToolPanel({ agent, tool, onClose }: { agent: Agent; tool?: AgentToolRow; onClose: () => void }) {
  const { save, listMcp } = useToolActions(agent.id);
  const start = (tool?.config as McpToolConfig | undefined) ?? null;
  const [title, setTitle] = useState(tool?.title ?? "");
  const [description, setDescription] = useState(tool?.description ?? "");
  const [url, setUrl] = useState(start?.url ?? "https://");
  const [tools, setTools] = useState<McpServerTool[]>(start?.tools ?? []);
  const [listedAt, setListedAt] = useState<string | null>(start?.listedAt ?? null);
  const [keyHeader, setKeyHeader] = useState("Authorization");
  const [keyValue, setKeyValue] = useState("");
  const [keyRemoved, setKeyRemoved] = useState(false);
  const allowed = tools.filter((t) => t.allowed).length;

  const connect = () =>
    listMcp.mutate(
      {
        url: url.trim(),
        ...(tool ? { toolId: tool.id } : {}),
        ...(secretOf(keyHeader, keyValue, keyRemoved) !== undefined
          ? { secret: secretOf(keyHeader, keyValue, keyRemoved) }
          : {}),
      },
      {
        onSuccess: (res) => {
          if (!res.ok) return notify.error("Couldn't connect", { description: res.error });
          setTools(res.tools);
          setListedAt(res.listedAt);
          if (!title.trim()) setTitle(new URL(url).hostname.replace(/^www\./, "").split(".")[0] ?? "");
          notify.success(`Found ${res.tools.length} tools`);
        },
        onError: (err) => notify.error("Couldn't connect", { description: errorText(err) }),
      },
    );

  const submit = () => {
    const secret = secretOf(keyHeader, keyValue, keyRemoved);
    save.mutate(
      {
        ...(tool ? { id: tool.id } : {}),
        kind: "mcp",
        title: title.trim(),
        description: description.trim(),
        enabled: tool?.enabled ?? true,
        confirm: false,
        config: { url: url.trim(), tools, listedAt },
        ...(secret !== undefined ? { secret } : {}),
      },
      {
        onSuccess: () => {
          notify.success("Saved");
          onClose();
        },
        onError: (err) => notify.error("Not saved", { description: errorText(err) }),
      },
    );
  };

  return (
    <SidePanel
      open
      onOpenChange={(open) => (open ? null : onClose())}
      width="lg"
      title={tool ? `Edit ${tool.title}` : "Connect an MCP server"}
      description={`Your system's MCP server: pick which of its tools ${agent.name} may use.`}
      footer={
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || title.trim().length < 2 || !allowed} onClick={submit}>
            {save.isPending ? "Saving…" : tool ? "Save" : "Connect"}
          </Button>
        </ModalActions>
      }
    >
      <div className="flex flex-col gap-7">
        <div className="flex flex-col gap-3">
          <Field label="Server address" hint="Streamable HTTP, e.g. https://mcp.example.com/mcp">
            <TextInput
              className="font-mono text-[13px]"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <KeyFields
            tool={tool}
            header={keyHeader}
            setHeader={setKeyHeader}
            value={keyValue}
            setValue={setKeyValue}
            removed={keyRemoved}
            setRemoved={setKeyRemoved}
          />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={listMcp.isPending || !/^https?:\/\/\S+\.\S+/.test(url)}
            onClick={connect}
          >
            <Icon name="refresh" size="sm" />{" "}
            {listMcp.isPending ? "Reading tools…" : tools.length ? "Read tools again" : "Read its tools"}
          </Button>
        </div>

        {tools.length ? (
          <>
            <div className="flex flex-col gap-3">
              <Field label="Name">
                <TextInput
                  maxLength={60}
                  placeholder="Shop"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="Notes for the agent" optional hint="Anything that helps it use these tools well.">
                <TextArea
                  minRows={2}
                  maxLength={1000}
                  placeholder="Order numbers start with #. Use stock before saying something is available."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">
                Tools {agent.name} may use ({allowed} of {tools.length})
              </h3>
              <p className="text-[13px] text-muted-foreground">
                Tools that change something ask the customer to tap Yes first, unless you turn that off.
              </p>
              <ul className="mt-2 divide-y rounded-lg border">
                {tools.map((t, i) => (
                  <li key={t.name} className="flex flex-col gap-1 px-3 py-1.5">
                    <CheckboxRow
                      label={
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[13px]">{t.name}</span>
                          {t.readOnly ? (
                            <Tag size="sm" tone="good">
                              Reads only
                            </Tag>
                          ) : null}
                        </span>
                      }
                      description={t.description || undefined}
                      checked={t.allowed}
                      onCheckedChange={(on) =>
                        setTools(tools.map((x, j) => (j === i ? { ...x, allowed: on } : x)))
                      }
                    />
                    {t.allowed ? (
                      <SwitchRow
                        className="pl-7"
                        label="Ask the customer to tap Yes first"
                        checked={t.confirm}
                        onCheckedChange={(on) =>
                          setTools(tools.map((x, j) => (j === i ? { ...x, confirm: on } : x)))
                        }
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
      </div>
    </SidePanel>
  );
}
