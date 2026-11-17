"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon, type IconName } from "@relay/ui/components/icon";
import { Panel, Section } from "@relay/ui/components/section";
import { Tag, type Tone } from "@relay/ui/components/tag";
import { TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { useRef, useState } from "react";
import { errorText } from "./agents-page";
import { type KnowledgeKind, type KnowledgeSource, useKnowledge, useKnowledgeActions } from "./queries";

/*
 * Knowledge: web pages, files, Q&A pairs and notes the agent answers from. Each is read and indexed in
 * the background (a few seconds); its status shows here. The Q&A view also holds short notes.
 */

const statusLook: Record<KnowledgeSource["status"], { label: string; tone: Tone }> = {
  queued: { label: "Waiting", tone: "plain" },
  indexing: { label: "Reading…", tone: "primary" },
  ready: { label: "Ready", tone: "good" },
  failed: { label: "Couldn't read", tone: "danger" },
};

export function KnowledgeView({ kind, canManage }: { kind: "website" | "file" | "qa"; canManage: boolean }) {
  const sources = useKnowledge();
  if (sources.isPending) return <Skeleton className="h-48 w-full" />;
  if (sources.isError)
    return (
      <EmptyState
        icon={<Icon name="alert" />}
        title="Couldn't load knowledge"
        description={errorText(sources.error)}
      />
    );
  const of = (k: KnowledgeKind) => sources.data.filter((s) => s.kind === k);
  if (kind === "website")
    return (
      <div className="flex flex-col gap-6">
        {canManage ? <AddWebsite /> : null}
        <SourceList
          sources={of("website")}
          canManage={canManage}
          empty="No web pages yet. Add your services, prices or FAQ page."
        />
      </div>
    );
  if (kind === "file")
    return (
      <div className="flex flex-col gap-6">
        {canManage ? <AddFile /> : null}
        <SourceList
          sources={of("file")}
          canManage={canManage}
          empty="No files yet. A price list or brochure is a good start."
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-8">
      <Section title="Questions and answers" description="Exact answers to what customers ask most.">
        {canManage ? <AddQa /> : null}
        <SourceList sources={of("qa")} canManage={canManage} empty="No questions yet." />
      </Section>
      <Section title="Notes" description="Anything else worth knowing: offers, policies, directions.">
        {canManage ? <AddNote /> : null}
        <SourceList sources={of("text")} canManage={canManage} empty="No notes yet." />
      </Section>
    </div>
  );
}

function AddWebsite() {
  const { add } = useKnowledgeActions();
  const [url, setUrl] = useState("");
  return (
    <Panel>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { kind: "website", url: url.trim() },
            {
              onSuccess: () => {
                setUrl("");
                notify.success("Reading the page", { description: "It's ready in a few seconds." });
              },
              onError: (err) => notify.error("Not added", { description: errorText(err) }),
            },
          );
        }}
      >
        <Field
          label="Web page address"
          hint="One page at a time, e.g. your prices or FAQ page."
          className="min-w-0 flex-1"
        >
          <TextInput
            type="url"
            inputMode="url"
            placeholder="https://"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={add.isPending || !/^https?:\/\/\S+\.\S+/i.test(url.trim())}>
          {add.isPending ? "Adding…" : "Add page"}
        </Button>
      </form>
    </Panel>
  );
}

function AddFile() {
  const { upload } = useKnowledgeActions();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const send = (files: FileList | null) => {
    for (const file of Array.from(files ?? []))
      upload.mutate(file, {
        onSuccess: () => notify.success(`Reading ${file.name}`),
        onError: (err) => notify.error(`${file.name} not added`, { description: errorText(err) }),
      });
  };
  return (
    <button
      type="button"
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        send(e.dataTransfer.files);
      }}
      className={`flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring ${dragging ? "border-primary bg-accent" : "bg-card"}`}
    >
      <Icon name="upload" />
      <span className="text-sm font-medium">
        {upload.isPending ? "Uploading…" : "Drop files here or choose files"}
      </span>
      <span className="text-[13px] text-muted-foreground">PDF, Word (.docx) or text, up to 20 MB each.</span>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".pdf,.docx,.txt,.md,.csv"
        onChange={(e) => {
          send(e.target.files);
          e.target.value = "";
        }}
      />
    </button>
  );
}

function AddQa() {
  const { add } = useKnowledgeActions();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  return (
    <Panel>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { kind: "qa", question: question.trim(), answer: answer.trim() },
            {
              onSuccess: () => {
                setQuestion("");
                setAnswer("");
                notify.success("Added");
              },
              onError: (err) => notify.error("Not added", { description: errorText(err) }),
            },
          );
        }}
      >
        <Field label="Question">
          <TextInput
            placeholder="Do you have parking?"
            maxLength={500}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </Field>
        <Field label="Answer">
          <TextArea
            placeholder="Yes, free parking in the basement."
            minRows={2}
            maxLength={4000}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          className="self-end"
          disabled={add.isPending || question.trim().length < 3 || !answer.trim()}
        >
          {add.isPending ? "Adding…" : "Add question"}
        </Button>
      </form>
    </Panel>
  );
}

function AddNote() {
  const { add } = useKnowledgeActions();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <Panel>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { kind: "text", title: title.trim(), body: body.trim() },
            {
              onSuccess: () => {
                setTitle("");
                setBody("");
                notify.success("Added");
              },
              onError: (err) => notify.error("Not added", { description: errorText(err) }),
            },
          );
        }}
      >
        <Field label="Title">
          <TextInput
            placeholder="November offer"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Note">
          <TextArea
            placeholder="20% off teeth whitening until 30 November."
            minRows={3}
            maxLength={50000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <Button type="submit" className="self-end" disabled={add.isPending || !title.trim() || !body.trim()}>
          {add.isPending ? "Adding…" : "Add note"}
        </Button>
      </form>
    </Panel>
  );
}

const kindIcon: Record<KnowledgeKind, IconName> = {
  website: "website",
  file: "file",
  qa: "help",
  text: "text",
};

function SourceList({
  sources,
  canManage,
  empty,
}: {
  sources: KnowledgeSource[];
  canManage: boolean;
  empty: string;
}) {
  const { remove, reindex } = useKnowledgeActions();
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  if (!sources.length) return <p className="px-1 text-[13px] text-muted-foreground">{empty}</p>;
  return (
    <Panel padding="none">
      {confirmDialog}
      <ul className="divide-y">
        {sources.map((s) => (
          <li key={s.id} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-start gap-3">
              <Icon name={kindIcon[s.kind]} size="sm" className="mt-0.5 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">
                  {s.kind === "website" ? s.title || s.url : s.title}
                </span>
                <span className="line-clamp-2 text-[13px] text-muted-foreground">
                  {s.kind === "qa"
                    ? s.qa?.answer
                    : s.kind === "text"
                      ? s.body
                      : s.kind === "website"
                        ? s.url
                        : s.fileName}
                </span>
                {s.status === "failed" && s.error ? (
                  <span className="text-[13px] text-destructive">{s.error}</span>
                ) : null}
              </div>
              <Tag size="sm" tone={statusLook[s.status].tone}>
                {statusLook[s.status].label}
              </Tag>
              {canManage ? (
                <div className="flex shrink-0 gap-1">
                  {s.kind === "qa" || s.kind === "text" ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Edit"
                      onClick={() => setEditing(editing === s.id ? null : s.id)}
                    >
                      <Icon name="edit" size="sm" />
                    </Button>
                  ) : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Read again"
                      disabled={reindex.isPending}
                      onClick={() => reindex.mutate(s.id)}
                    >
                      <Icon name="refresh" size="sm" />
                    </Button>
                  )}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Delete"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: "Delete this?",
                          description: "Your agent will stop answering from it.",
                          confirmLabel: "Delete",
                          tone: "danger",
                        })
                      )
                        remove.mutate(s.id, {
                          onError: (err) => notify.error("Not deleted", { description: errorText(err) }),
                        });
                    }}
                  >
                    <Icon name="delete" size="sm" />
                  </Button>
                </div>
              ) : null}
            </div>
            {editing === s.id ? <EditSource source={s} onDone={() => setEditing(null)} /> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function EditSource({ source, onDone }: { source: KnowledgeSource; onDone: () => void }) {
  const { edit } = useKnowledgeActions();
  const [a, setA] = useState(source.kind === "qa" ? (source.qa?.question ?? "") : source.title);
  const [b, setB] = useState(source.kind === "qa" ? (source.qa?.answer ?? "") : (source.body ?? ""));
  return (
    <form
      className="flex flex-col gap-2 pl-7"
      onSubmit={(e) => {
        e.preventDefault();
        edit.mutate(
          source.kind === "qa"
            ? { id: source.id, question: a.trim(), answer: b.trim() }
            : { id: source.id, title: a.trim(), body: b.trim() },
          {
            onSuccess: () => {
              notify.success("Saved");
              onDone();
            },
            onError: (err) => notify.error("Not saved", { description: errorText(err) }),
          },
        );
      }}
    >
      <TextInput
        aria-label={source.kind === "qa" ? "Question" : "Title"}
        value={a}
        onChange={(e) => setA(e.target.value)}
      />
      <TextArea
        aria-label={source.kind === "qa" ? "Answer" : "Note"}
        value={b}
        minRows={2}
        onChange={(e) => setB(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={edit.isPending || !a.trim() || !b.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
