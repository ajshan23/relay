"use client";

import {
  type AuthSettings,
  authContent,
  checkTemplate,
  commonDetails,
  type TemplateButton,
  type TemplateContent,
  type TemplateLimits,
  type TemplatePurpose,
  type TemplateVariable,
  templatePurposes,
  templateVariables,
} from "@relay/core/templates";
import { CheckboxRow, Segmented } from "@relay/ui/components/choice";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@relay/ui/ui/empty";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Spinner } from "@relay/ui/ui/spinner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChannelStatus, MessagePreview, statusLook } from "./parts";
import {
  NotPublished,
  type Template,
  type TemplateChannel,
  uploadHeaderFile,
  useLibrary,
  useSaveTemplate,
  useTemplate,
  useTemplates,
} from "./queries";
import { useReviewToasts } from "./templates-list";

/** Used for checks before any channel with templates is connected. */
const fallbackLimits: TemplateLimits = {
  requiresApproval: false,
  reviewEstimate: null,
  purposes: ["updates", "marketing", "login"],
  headerKinds: ["text", "image", "video", "document"],
  buttonKinds: ["reply", "link", "call"],
  maxButtons: 3,
  maxBodyLength: 1024,
  maxHeaderTextLength: 60,
  maxFooterLength: 60,
  maxButtonTextLength: 25,
  editNote: null,
};

const emptyContent: TemplateContent = { header: null, body: "", footer: null, buttons: [] };
const defaultAuth: AuthSettings = { securityNote: true, expiresInMinutes: 10, buttonText: "Copy code" };

const languages = [
  { value: "en", label: "English" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
  { value: "ml", label: "Malayalam" },
  { value: "ur", label: "Urdu" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
];

type Draft = {
  name: string;
  purpose: TemplatePurpose;
  language: string;
  content: TemplateContent;
  examples: Record<string, string>;
  headerFileName: string | null;
  headerUrl: string | null;
};

function FormBlock({
  title,
  hint,
  children,
  aside,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">{title}</h3>
          {hint ? <p className="mt-0.5 text-[13px] text-muted-foreground">{hint}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </Panel>
  );
}

export function TemplateEditor({ id, fromKey }: { id: string | null; fromKey: string | null }) {
  const router = useRouter();
  const data = useTemplates();
  const existing = useTemplate(id);
  const library = useLibrary();
  const save = useSaveTemplate(id);
  const [confirm, confirmElement] = useConfirm();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [showIssues, setShowIssues] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const body = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const channels = data.data?.channels ?? [];
  const templateChannels = channels.filter((c) => c.limits);
  const template = existing.data;
  useReviewToasts(template ? [template] : undefined);

  // Start from the saved template, a library entry, or a blank page.
  useEffect(() => {
    if (draft) return;
    if (id) {
      if (!template) return;
      setDraft({
        name: template.name,
        purpose: template.purpose,
        language: template.language,
        content: template.content,
        examples: Object.fromEntries(template.variables.map((v) => [v.name, v.example])),
        headerFileName: null,
        headerUrl:
          template.content.header &&
          template.content.header.kind !== "text" &&
          template.content.header.attachmentId
            ? `/api/attachments/${template.content.header.attachmentId}`
            : null,
      });
      setChannelIds(template.channels.map((c) => c.channelId));
      return;
    }
    if (fromKey && !library.data) return;
    const from = library.data?.find((t) => t.key === fromKey);
    setDraft({
      name: from?.name ?? "",
      purpose: from?.purpose ?? "updates",
      language: "en",
      content: from?.content ?? emptyContent,
      examples: Object.fromEntries((from?.variables ?? []).map((v) => [v.name, v.example])),
      headerFileName: null,
      headerUrl: null,
    });
  }, [draft, id, template, fromKey, library.data]);

  // New templates go to every active channel that uses templates, unless the person unticks them.
  const picked = useRef(false);
  useEffect(() => {
    if (id || picked.current || !templateChannels.length) return;
    picked.current = true;
    setChannelIds(templateChannels.filter((c) => c.status === "active").map((c) => c.id));
  }, [id, templateChannels]);

  const chosen = templateChannels.filter((c) => channelIds.includes(c.id));
  const limits = chosen[0]?.limits ?? templateChannels[0]?.limits ?? fallbackLimits;
  const needsReview = chosen.some((c) => c.limits?.requiresApproval);
  const estimate = chosen.find((c) => c.limits?.reviewEstimate)?.limits?.reviewEstimate ?? null;
  const published = !!template?.channels.some((c) => c.status !== "draft");
  const canManage = data.data?.canManage ?? false;

  const names = useMemo(() => (draft ? templateVariables(draft.content) : []), [draft]);
  const variables: TemplateVariable[] = names.map((n) => ({ name: n, example: draft?.examples[n] ?? "" }));
  const issues = draft ? checkTemplate({ name: draft.name, content: draft.content, variables }, limits) : [];
  const issueFor = (field: string) =>
    showIssues ? issues.find((i) => i.field === field)?.message : undefined;

  if (existing.isError)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon name="alert" />
          </EmptyMedia>
          <EmptyTitle>Template not found</EmptyTitle>
          <EmptyDescription>It may have been deleted.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings/templates">Back to templates</Link>
        </Button>
      </Empty>
    );
  if (!draft || data.isPending)
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setContent = (patch: Partial<TemplateContent>) =>
    setDraft((d) => (d ? { ...d, content: { ...d.content, ...patch } } : d));

  function insertDetail(name: string, example: string) {
    const el = body.current;
    const text = draft?.content.body ?? "";
    const at = el ? el.selectionStart : text.length;
    const before = text.slice(0, at);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const token = `${pad}{{${name}}}`;
    const next = before + token + text.slice(el ? el.selectionEnd : at);
    setDraft((d) =>
      d
        ? {
            ...d,
            content: { ...d.content, body: next },
            examples: { ...d.examples, [name]: d.examples[name] || example },
          }
        : d,
    );
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length + token.length, before.length + token.length);
    });
  }

  function addCustomDetail() {
    const name = customName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (!name) return;
    insertDetail(name, "");
    setCustomName("");
    setCustomOpen(false);
  }

  async function onHeaderFile(file: File) {
    setUploading(true);
    try {
      const up = await uploadHeaderFile(file);
      set({ headerFileName: up.fileName, headerUrl: up.url });
      setContent({ header: { kind: up.kind as "image" | "video" | "document", attachmentId: up.id } });
    } catch (err) {
      notify.error("That file can't be used", {
        description: err instanceof ApiError ? err.message : "Check your connection and try again.",
      });
    } finally {
      setUploading(false);
    }
  }

  function setButton(i: number, b: TemplateButton | null) {
    const list = [...(draft?.content.buttons ?? [])];
    if (b) list[i] = b;
    else list.splice(i, 1);
    setContent({ buttons: list });
  }

  async function submit(publish: boolean) {
    if (!draft) return;
    setShowIssues(true);
    if (!draft.name.trim()) {
      notify.error("Give the template a name first.");
      return;
    }
    if (publish && issues.length) {
      notify.error("A few things to fix first", { description: issues[0]?.message });
      return;
    }
    if (publish && published && limits.editNote) {
      const ok = await confirm({
        title: "Send the changes for review?",
        description: `${limits.editNote} Until it's approved again, the channel decides whether the earlier version can still be sent.`,
        confirmLabel: "Send for review",
      });
      if (!ok) return;
    }
    save.mutate(
      {
        name: draft.name.trim(),
        language: draft.language,
        purpose: draft.purpose,
        content: draft.content,
        variables,
        channelIds: publish ? channelIds : undefined,
      },
      {
        onSuccess: (t) => {
          if (publish && needsReview)
            notify.success("Sent for review", {
              description: `This usually takes ${estimate ?? "a little while"}. You can keep working; we'll update it here.`,
            });
          else notify.success(publish ? "Template saved and ready" : "Draft saved");
          router.replace(`/settings/templates/${t.id}${publish ? "?sent=1" : ""}`);
        },
        onError: (err) => {
          if (err instanceof NotPublished) {
            notify.error("Saved as a draft, not sent yet", { description: err.message });
            if (err.template && !id) router.replace(`/settings/templates/${err.template.id}`);
            return;
          }
          notify.error("Couldn't save it", {
            description: err instanceof ApiError ? err.message : "Check your connection.",
          });
        },
      },
    );
  }

  const headerKind = draft.content.header?.kind ?? "none";
  const headerOptions = [
    { value: "none", label: "None" },
    ...limits.headerKinds.map((k) => ({
      value: k,
      label: k === "text" ? "Text" : k === "image" ? "Picture" : k === "video" ? "Video" : "Document",
    })),
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/settings/templates"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <Icon name="arrowLeft" size="sm" />
          Templates
        </Link>
      </div>

      {template?.channels.length ? <StatusBanner template={template} estimate={estimate} /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <FormBlock title="Name and purpose">
            <Field
              label="Template name"
              hint={
                published
                  ? `Published as ${template?.slug}. The name can change; channels keep the original.`
                  : "Only your team sees this."
              }
              error={issueFor("name")}
            >
              <TextInput
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="Appointment reminder"
                disabled={!canManage}
              />
            </Field>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">What is it for?</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {(Object.keys(templatePurposes) as TemplatePurpose[])
                  .filter((p) => limits.purposes.includes(p))
                  .map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={draft.purpose === p}
                      disabled={!canManage}
                      onClick={() =>
                        setDraft((d) => {
                          if (!d || d.purpose === p) return d;
                          // Authentication uses the channel's fixed wording; leaving it starts a blank message.
                          if (p === "login")
                            return {
                              ...d,
                              purpose: p,
                              content: authContent(defaultAuth),
                              examples: { code: "482913" },
                            };
                          if (d.purpose === "login")
                            return { ...d, purpose: p, content: emptyContent, examples: {} };
                          return { ...d, purpose: p };
                        })
                      }
                      className={cn(
                        "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        draft.purpose === p ? "border-primary bg-primary/5" : "hover:bg-muted/60",
                      )}
                    >
                      <span className="flex items-center justify-between text-sm font-medium">
                        {templatePurposes[p].label}
                        {draft.purpose === p ? (
                          <Icon name="check" size="sm" className="text-primary" />
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{templatePurposes[p].hint}</span>
                    </button>
                  ))}
              </div>
            </div>
            <Field label="Language" hint={published ? "Fixed once published." : undefined}>
              <SelectField
                options={languages}
                value={draft.language}
                onValueChange={(v) => set({ language: v })}
                disabled={!canManage || published}
              />
            </Field>
          </FormBlock>

          {draft.purpose === "login" ? (
            <AuthBlock
              settings={draft.content.auth ?? defaultAuth}
              disabled={!canManage}
              limits={limits}
              error={issueFor("footer") ?? issueFor("buttons")}
              onChange={(a) =>
                setDraft((d) =>
                  d ? { ...d, content: authContent(a), examples: { code: d.examples.code || "482913" } } : d,
                )
              }
            />
          ) : (
            <>
              <FormBlock
                title="Message"
                hint="Write it the way you'd say it. Add details like the customer's name; they're filled in when you send."
              >
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">
                    Header <span className="text-xs font-normal text-muted-foreground">Optional</span>
                  </p>
                  <Segmented
                    aria-label="Header"
                    size="sm"
                    value={headerKind}
                    disabled={!canManage}
                    onChange={(v) => {
                      if (v === "none") setContent({ header: null });
                      else if (v === "text") setContent({ header: { kind: "text", text: "" } });
                      else {
                        setContent({
                          header: { kind: v as "image" | "video" | "document", attachmentId: null },
                        });
                        set({ headerFileName: null, headerUrl: null });
                      }
                    }}
                    options={headerOptions}
                  />
                  {draft.content.header?.kind === "text" ? (
                    <Field label="Header text" hideLabel error={issueFor("header")}>
                      <TextInput
                        value={draft.content.header.text}
                        onChange={(e) => setContent({ header: { kind: "text", text: e.target.value } })}
                        placeholder="Appointment reminder"
                        maxLength={limits.maxHeaderTextLength}
                        disabled={!canManage}
                      />
                    </Field>
                  ) : draft.content.header ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        ref={picker}
                        type="file"
                        className="hidden"
                        accept={
                          draft.content.header.kind === "image"
                            ? "image/jpeg,image/png"
                            : draft.content.header.kind === "video"
                              ? "video/mp4"
                              : "application/pdf"
                        }
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void onHeaderFile(f);
                        }}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={uploading || !canManage}
                        onClick={() => picker.current?.click()}
                      >
                        {uploading ? <Spinner /> : <Icon name="upload" />}
                        {draft.content.header.attachmentId ? "Replace file" : "Choose file"}
                      </Button>
                      <span className="text-[13px] text-muted-foreground">
                        {draft.headerFileName ??
                          (draft.content.header.attachmentId
                            ? "File added"
                            : "The reviewer sees it as an example; you can choose a different one when sending.")}
                      </span>
                      {issueFor("header") ? (
                        <p className="w-full text-[13px] text-destructive">{issueFor("header")}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <Field
                  label="Message"
                  error={issueFor("body")}
                  hint={`${draft.content.body.length} / ${limits.maxBodyLength}`}
                >
                  {(control) => (
                    <div className="flex flex-col gap-2">
                      <TextArea
                        {...control}
                        ref={body}
                        value={draft.content.body}
                        onChange={(e) => setContent({ body: e.target.value })}
                        minRows={5}
                        maxRows={14}
                        placeholder="Hi {{customer_name}}, …"
                        disabled={!canManage}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" disabled={!canManage}>
                              <Icon name="add" />
                              Add detail
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-56">
                            {commonDetails.map((d) => (
                              <DropdownMenuItem key={d.name} onSelect={() => insertDetail(d.name, d.example)}>
                                {d.label}
                                <span className="ml-auto text-xs text-muted-foreground">{d.example}</span>
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setCustomOpen(true)}>
                              Something else…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {customOpen ? (
                          <span className="flex items-center gap-1.5">
                            <TextInput
                              size="sm"
                              autoFocus
                              value={customName}
                              aria-label="Name of the detail"
                              placeholder="e.g. treatment, doctor"
                              onChange={(e) => setCustomName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addCustomDetail();
                                }
                                if (e.key === "Escape") setCustomOpen(false);
                              }}
                              wrapperClassName="w-44"
                              className="w-44"
                            />
                            <Button size="sm" variant="secondary" onClick={addCustomDetail}>
                              Add
                            </Button>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Details appear as highlights in the preview.
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </Field>

                <Field
                  label="Footer"
                  optional
                  hint="A small grey line under the message, such as how to stop messages."
                  error={issueFor("footer")}
                >
                  <TextInput
                    value={draft.content.footer ?? ""}
                    onChange={(e) => setContent({ footer: e.target.value || null })}
                    placeholder="Reply STOP to stop reminders"
                    maxLength={limits.maxFooterLength}
                    disabled={!canManage}
                  />
                </Field>
              </FormBlock>

              <FormBlock
                title="Buttons"
                hint="Optional. One tap to reply, open a link or call you."
                aside={
                  canManage && draft.content.buttons.length < limits.maxButtons ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Icon name="add" />
                          Add button
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {limits.buttonKinds.includes("reply") ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              setButton(draft.content.buttons.length, { kind: "reply", text: "" })
                            }
                          >
                            <Icon name="reply" size="sm" />
                            Quick reply
                          </DropdownMenuItem>
                        ) : null}
                        {limits.buttonKinds.includes("link") ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              setButton(draft.content.buttons.length, {
                                kind: "link",
                                text: "",
                                url: "https://",
                              })
                            }
                          >
                            <Icon name="external" size="sm" />
                            Open a link
                          </DropdownMenuItem>
                        ) : null}
                        {limits.buttonKinds.includes("call") ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              setButton(draft.content.buttons.length, {
                                kind: "call",
                                text: "Call us",
                                phone: "",
                              })
                            }
                          >
                            <Icon name="phone" size="sm" />
                            Call us
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null
                }
              >
                {draft.content.buttons.length ? (
                  <div className="flex flex-col gap-3">
                    {draft.content.buttons.map((b, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: buttons are edited by position
                      <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                        <Field
                          label={
                            b.kind === "reply"
                              ? "Quick reply"
                              : b.kind === "link"
                                ? "Link button"
                                : "Call button"
                          }
                          className="min-w-40 flex-1"
                        >
                          <TextInput
                            value={b.text}
                            maxLength={limits.maxButtonTextLength}
                            placeholder="Label"
                            onChange={(e) => setButton(i, { ...b, text: e.target.value })}
                            disabled={!canManage}
                          />
                        </Field>
                        {b.kind === "link" ? (
                          <Field label="Web address" className="min-w-52 flex-[2]">
                            <TextInput
                              value={b.url}
                              onChange={(e) => setButton(i, { ...b, url: e.target.value })}
                              disabled={!canManage}
                            />
                          </Field>
                        ) : b.kind === "call" ? (
                          <Field label="Phone number" className="min-w-44 flex-[2]">
                            <TextInput
                              value={b.phone}
                              placeholder="+971 4 123 4567"
                              onChange={(e) => setButton(i, { ...b, phone: e.target.value })}
                              disabled={!canManage}
                            />
                          </Field>
                        ) : null}
                        {canManage ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove button"
                            onClick={() => setButton(i, null)}
                          >
                            <Icon name="delete" />
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {issueFor("buttons") ? (
                      <p className="text-[13px] text-destructive">{issueFor("buttons")}</p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">No buttons.</p>
                )}
              </FormBlock>

              {names.length ? (
                <FormBlock
                  title="Examples for the reviewer"
                  hint="Reviewers read the message with these filled in. Real-looking examples get approved faster."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    {names.map((n) => (
                      <Field key={n} label={n.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}>
                        <TextInput
                          value={draft.examples[n] ?? ""}
                          onChange={(e) => set({ examples: { ...draft.examples, [n]: e.target.value } })}
                          disabled={!canManage}
                        />
                      </Field>
                    ))}
                  </div>
                  {issueFor("variables") ? (
                    <p className="text-[13px] text-destructive">{issueFor("variables")}</p>
                  ) : null}
                </FormBlock>
              ) : null}
            </>
          )}

          <FormBlock title="Send to" hint="Write it once, use it on every channel you pick.">
            <ChannelPicker
              channels={channels}
              selected={channelIds}
              onChange={setChannelIds}
              disabled={!canManage}
              publishedIds={template?.channels.map((c) => c.channelId) ?? []}
            />
          </FormBlock>

          {canManage ? (
            <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
              {showIssues && issues.length ? (
                <p className="mr-auto flex items-center gap-1.5 text-[13px] text-destructive">
                  <Icon name="alert" size="sm" />
                  {issues.length === 1 ? issues[0]?.message : `${issues.length} things to fix before sending`}
                </p>
              ) : needsReview ? (
                <p className="mr-auto hidden text-[13px] text-muted-foreground sm:block">
                  Review usually takes {estimate ?? "a little while"}. You can keep working meanwhile.
                </p>
              ) : null}
              <Button variant="ghost" asChild>
                <Link href="/settings/templates">Cancel</Link>
              </Button>
              {!published ? (
                <Button variant="outline" disabled={save.isPending} onClick={() => void submit(false)}>
                  Save draft
                </Button>
              ) : null}
              <Button disabled={save.isPending || !channelIds.length} onClick={() => void submit(true)}>
                {save.isPending ? <Spinner /> : <Icon name="send" />}
                {published
                  ? needsReview
                    ? "Save and send for review"
                    : "Save changes"
                  : needsReview
                    ? "Send for review"
                    : "Save and publish"}
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Only owners, admins and branch managers can change templates.
            </p>
          )}
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <MessagePreview
            content={draft.content}
            variables={variables}
            headerUrl={draft.headerUrl}
            caption={<p className="text-center text-xs text-muted-foreground">Preview with your examples</p>}
          />
        </div>
      </div>
      {confirmElement}
    </div>
  );
}

function ChannelPicker({
  channels,
  selected,
  onChange,
  disabled,
  publishedIds,
}: {
  channels: TemplateChannel[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  publishedIds: string[];
}) {
  if (!channels.length)
    return (
      <p className="text-[13px] text-muted-foreground">
        No channels connected yet. Save it as a draft; you can send it once a channel is connected.
      </p>
    );
  return (
    <div className="flex flex-col divide-y">
      {channels.map((c) => {
        const on = selected.includes(c.id);
        const locked = publishedIds.includes(c.id);
        return (
          <CheckboxRow
            key={c.id}
            label={c.name}
            description={
              !c.limits
                ? "This channel doesn't use templates."
                : locked
                  ? "Already published here."
                  : c.limits.requiresApproval
                    ? `Reviewed by the channel, usually ${c.limits.reviewEstimate ?? "quickly"}.`
                    : "Ready straight away."
            }
            checked={on}
            disabled={disabled || !c.limits || locked}
            onCheckedChange={(v) => onChange(v ? [...selected, c.id] : selected.filter((x) => x !== c.id))}
          />
        );
      })}
    </div>
  );
}

/** Where the template stands on each channel, at the top of a published template. */
function StatusBanner({ template, estimate }: { template: Template; estimate: string | null }) {
  const reviewing = template.channels.some((c) => c.status === "in_review");
  const fix = template.channels.find((c) => c.status === "needs_changes" || c.status === "paused");
  const allReady = template.channels.every((c) => c.status === "ready");
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start",
        fix ? "border-destructive/30 bg-destructive/5" : allReady ? "border-good/30 bg-good-soft" : "bg-card",
      )}
    >
      <span
        className={cn(
          "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
          fix
            ? "bg-destructive/10 text-destructive"
            : allReady
              ? "bg-good/15 text-good"
              : "bg-warning-soft text-warning",
        )}
      >
        <Icon name={fix ? "alert" : allReady ? "check" : "clock"} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-sm font-semibold">
          {fix
            ? "A channel asked for a change"
            : allReady
              ? "Ready to send"
              : reviewing
                ? "In review"
                : statusLook[template.channels[0]?.status ?? "draft"].label}
        </p>
        <p className="text-[13px] text-muted-foreground">
          {fix
            ? `${fix.reason ?? "Open the message below, adjust it, and send it again."} Change the message below and send it again.`
            : allReady
              ? "Your team can pick it in any conversation on these channels, even after the 24-hour window."
              : `This usually takes ${estimate ?? "a little while"}. You can close this page; it updates here and you'll get a note when it's done.`}
        </p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {template.channels.map((c) => (
            <ChannelStatus key={c.channelId} copy={c} estimate={estimate} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Authentication templates: the channel fixes the wording; the business picks these three things. */
function AuthBlock({
  settings,
  onChange,
  disabled,
  limits,
  error,
}: {
  settings: AuthSettings;
  onChange: (a: AuthSettings) => void;
  disabled: boolean;
  limits: TemplateLimits;
  error?: string;
}) {
  return (
    <FormBlock
      title="Code message"
      hint="WhatsApp writes the text of code messages itself, so they're always clear and safe. You choose the extras."
    >
      <CheckboxRow
        label="Add a security note"
        description="“For your security, do not share this code.”"
        checked={settings.securityNote}
        disabled={disabled}
        onCheckedChange={(v) => onChange({ ...settings, securityNote: v })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code expires after" hint="1 to 90 minutes. Leave empty for no expiry line.">
          <TextInput
            type="number"
            min={1}
            max={90}
            value={settings.expiresInMinutes ?? ""}
            disabled={disabled}
            trailing={<span className="text-xs text-muted-foreground">minutes</span>}
            onChange={(e) =>
              onChange({
                ...settings,
                expiresInMinutes: e.target.value ? Math.round(Number(e.target.value)) : null,
              })
            }
          />
        </Field>
        <Field label="Copy button label">
          <TextInput
            value={settings.buttonText}
            maxLength={limits.maxButtonTextLength}
            disabled={disabled}
            onChange={(e) => onChange({ ...settings, buttonText: e.target.value })}
          />
        </Field>
      </div>
      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
    </FormBlock>
  );
}
