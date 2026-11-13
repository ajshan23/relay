"use client";

import { fillVariables, templatePurposes, templateVariables } from "@relay/core/templates";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Modal } from "@relay/ui/components/modal";
import { SearchInput, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MessagePreview } from "@/components/templates/parts";
import { type Template, useTemplates } from "@/components/templates/queries";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";
import { cn } from "@/lib/utils";
import { useSend } from "./queries";
import type { ConversationDetail } from "./types";

/** Details Relay can fill in by itself from the conversation and the business. */
function knownValues(detail: ConversationDetail, businessName: string): Record<string, string> {
  const first = detail.conversation.kind === "direct" ? (detail.conversation.title.split(" ")[0] ?? "") : "";
  const looksLikeName = first && !/^\+?\d/.test(first);
  return {
    ...(looksLikeName ? { customer_name: first } : {}),
    business_name: businessName,
    ...(detail.branch ? { branch: detail.branch.name } : {}),
  };
}

type Props = { detail: ConversationDetail; open: boolean; onOpenChange: (open: boolean) => void };

/**
 * Pick a ready template for this conversation's channel, fill in its details and send it. Works
 * after the reply window has closed; that's what templates are for.
 */
export function TemplatePicker({ detail, open, onOpenChange }: Props) {
  const { me } = useMe();
  const data = useTemplates();
  const send = useSend(detail.conversation.id);
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showMissing, setShowMissing] = useState(false);

  const ready = useMemo(
    () =>
      (data.data?.templates ?? []).filter((t) =>
        t.channels.some((c) => c.channelId === detail.channel.id && c.status === "ready"),
      ),
    [data.data, detail.channel.id],
  );
  const waiting = (data.data?.templates ?? []).filter((t) =>
    t.channels.some((c) => c.channelId === detail.channel.id && c.status === "in_review"),
  ).length;
  const shown = ready.filter((t) =>
    `${t.name} ${t.content.body}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const selected: Template | undefined = ready.find((t) => t.id === selectedId) ?? shown[0];
  const names = selected ? templateVariables(selected.content) : [];

  // Pre-fill what Relay already knows whenever a template is chosen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refill only when the choice changes
  useEffect(() => {
    if (!selected) return;
    const known = knownValues(detail, me.organization?.name ?? "");
    setValues(Object.fromEntries(names.map((n) => [n, known[n] ?? ""])));
    setShowMissing(false);
  }, [selected?.id]);

  const missing = names.filter((n) => !values[n]?.trim());

  function submit() {
    if (!selected) return;
    if (missing.length) {
      setShowMissing(true);
      return;
    }
    const c = selected.content;
    send.mutate(
      {
        senderName: me.user.name,
        template: {
          id: selected.id,
          values,
          rendered: {
            header: c.header?.kind === "text" ? fillVariables(c.header.text, values) : null,
            body: fillVariables(c.body, values),
            footer: c.footer,
            buttons: c.buttons.map((b) => ({ text: b.text })),
          },
        },
      },
      {
        onError: (err) =>
          notify.error("Template not sent", {
            description: err instanceof ApiError ? err.message : "Check your connection and try again.",
          }),
      },
    );
    onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Send a template"
      description={`Approved messages for ${detail.channel.name}. They can be sent any time, even after the 24-hour window.`}
      size="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Button variant="ghost" asChild>
            <Link href="/settings/templates">Manage templates</Link>
          </Button>
          <Button disabled={!selected || send.isPending} onClick={submit}>
            <Icon name="send" />
            Send template
          </Button>
        </div>
      }
    >
      {data.isPending ? (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : !ready.length ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Icon name="file" />
          </span>
          <p className="font-medium">No templates ready on this channel yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {waiting
              ? `${waiting} ${waiting === 1 ? "is" : "are"} in review; ${waiting === 1 ? "it" : "they"} will show up here once approved.`
              : "Add one from the ready-made list in a minute. Once approved it shows up here."}
          </p>
          <Button variant="outline" size="sm" asChild className="mt-2">
            <Link href="/settings/templates">Go to templates</Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-3">
            <SearchInput
              size="sm"
              placeholder="Search templates"
              aria-label="Search templates"
              onValueChange={setQ}
            />
            <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={selected?.id === t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={cn(
                    "flex items-baseline justify-between gap-3 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    selected?.id === t.id ? "bg-accent" : "hover:bg-muted",
                  )}
                >
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {templatePurposes[t.purpose].label}
                  </span>
                </button>
              ))}
              {!shown.length ? (
                <p className="px-2.5 py-3 text-sm text-muted-foreground">No matches.</p>
              ) : null}
            </div>
            {names.length ? (
              <div className="flex flex-col gap-3 border-t pt-3">
                <p className="text-sm font-medium">Fill in the details</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {names.map((n) => (
                    <Field
                      key={n}
                      label={n.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase())}
                      error={showMissing && !values[n]?.trim() ? "Needed" : undefined}
                    >
                      <TextInput
                        value={values[n] ?? ""}
                        placeholder={selected?.variables.find((v) => v.name === n)?.example}
                        onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            ) : (
              <p className="border-t pt-3 text-sm text-muted-foreground">
                Nothing to fill in. It's ready to send.
              </p>
            )}
          </div>
          {selected ? (
            <MessagePreview
              content={selected.content}
              variables={names.map((n) => ({ name: n, example: values[n] ?? "" }))}
              headerUrl={
                selected.content.header &&
                selected.content.header.kind !== "text" &&
                selected.content.header.attachmentId
                  ? `/api/attachments/${selected.content.header.attachmentId}`
                  : null
              }
              caption={
                <p className="text-center text-xs text-muted-foreground">
                  What {detail.conversation.title} will see
                </p>
              }
            />
          ) : null}
        </div>
      )}
    </Modal>
  );
}
