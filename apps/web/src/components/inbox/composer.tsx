"use client";

import { fillQuickReply } from "@relay/core/quick-replies";
import { Segmented } from "@relay/ui/components/choice";
import { Icon } from "@relay/ui/components/icon";
import { TextArea } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@relay/ui/ui/attachment";
import { Button } from "@relay/ui/ui/button";
import { Spinner } from "@relay/ui/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relay/ui/ui/tooltip";
import Link from "next/link";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ItemPicker } from "@/components/catalog/item-picker";
import { useQuickReplies } from "@/components/quick-replies/queries";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";
import { cn } from "@/lib/utils";
import { fileSize, kindWord, windowLeft } from "./format";
import { reportTyping } from "./presence";
import { upload as uploadFile, useAddNote, useAssignees, useSend, useTypingSignal } from "./queries";
import { type Suggestion, SuggestionList, tokenAtCaret } from "./suggestions";
import { TemplatePicker } from "./template-picker";
import type { ConversationDetail, Message, Upload } from "./types";
import { VoiceRecorder } from "./voice-recorder";

type Props = {
  detail: ConversationDetail;
  replyTo: Message | null;
  onClearReply: () => void;
  /** A file dropped on the conversation, handed over by the thread. */
  dropped: File | null;
  onDroppedHandled: () => void;
};

type Pending = { file: File; upload: Upload | null; error: string | null };

/** Re-renders every 30 s so the window countdown stays current. */
function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

export function Composer({ detail, replyTo, onClearReply, dropped, onDroppedHandled }: Props) {
  const { me } = useMe();
  const id = detail.conversation.id;
  const send = useSend(id);
  const [text, setText] = useState("");
  const typing = useTypingSignal(id);
  /** Reply goes to the customer; Note stays inside the team. */
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const note = mode === "note";
  const addNote = useAddNote(id);
  const team = useAssignees(id, note && detail.canWork);
  const quick = useQuickReplies(detail.canWork);
  /** "@Name" typed in a note → that teammate's id, turned into "@[Name](id)" when sent. */
  const mentioned = useRef(new Map<string, string>());
  const [token, setToken] = useState<{ query: string; start: number; end: number } | null>(null);
  // The N key switches to a note (shortcuts.tsx).
  useEffect(() => {
    const onKey = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== "note" || !detail.canWork) return;
      setMode("note");
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener("relay:inbox-shortcut", onKey);
    return () => window.removeEventListener("relay:inbox-shortcut", onKey);
  }, [detail.canWork]);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const now = useNow();

  const caps = detail.capabilities;
  const left = windowLeft(detail.conversation.windowExpiresAt, now);
  const groupDown = detail.group && detail.group.status !== "active";
  /** Someone is writing a reply: tell the customer, inside the reply window (the server checks the channel). */
  const onTyping = (value: string) => {
    if (value.trim()) reportTyping(id); // teammates see "typing…" (inside Relay)
    if (detail.canWork && !detail.group && left) typing(value);
  };
  const lock = !detail.canWork
    ? "You can read this conversation but not reply. Ask a manager for agent access."
    : !caps
      ? "Replies on this channel aren't available yet."
      : detail.channel.status !== "active"
        ? `The channel is ${detail.channel.status}. Reconnect it to reply.`
        : groupDown
          ? `The group is ${detail.group?.status}. Messages can't be sent to it.`
          : !left
            ? caps.replyWindowHours
              ? `The ${caps.replyWindowHours}-hour reply window has closed. Send a template to start the conversation again; once the customer replies, you can write freely.`
              : "Replies aren't open for this conversation."
            : null;

  // Teammates to @mention while writing a note; quick replies ("/") while writing a reply.
  const suggestions: Suggestion[] = !token
    ? []
    : note
      ? (team.data ?? [])
          .filter((u) => u.id !== me.user.id && (u.name ?? "").toLowerCase().includes(token.query))
          .slice(0, 8)
          .map((u) => ({ id: u.id, label: u.name ?? "Teammate" }))
      : (quick.data ?? [])
          .filter((r) => r.shortcut.includes(token.query) || r.title.toLowerCase().includes(token.query))
          .slice(0, 8)
          .map((r) => ({ id: r.id, label: `/${r.shortcut}`, hint: r.title, detail: r.body }));
  const suggesting = !!token;

  /** Replaces the "@que" or "/que" being typed with the teammate's name or the quick reply's text. */
  function pick(item: Suggestion) {
    if (!token) return;
    const reply = note ? null : quick.data?.find((r) => r.id === item.id);
    const name = detail.conversation.kind === "direct" ? detail.conversation.title : null;
    const insert = reply
      ? fillQuickReply(reply.body, {
          name,
          first_name: name?.split(/\s+/)[0] ?? null,
          agent_name: me.user.name,
          business_name: me.organization?.name ?? null,
        })
      : `@${item.label} `;
    const next = text.slice(0, token.start) + insert + text.slice(token.end);
    if (!reply) mentioned.current.set(item.label, item.id);
    setText(next);
    setToken(null);
    const caret = token.start + insert.length;
    requestAnimationFrame(() => input.current?.setSelectionRange(caret, caret));
  }

  // Templates can still go out when only the window is closed.
  const windowOnly =
    !!lock && !!caps && detail.canWork && detail.channel.status === "active" && !groupDown && !left;
  const canTemplate = !!caps?.templates && caps.outboundTypes.includes("template");
  const [picking, setPicking] = useState(false);
  const [pickingItems, setPickingItems] = useState(false);
  const pickerDialog = canTemplate ? (
    <TemplatePicker detail={detail} open={picking} onOpenChange={setPicking} />
  ) : null;

  // Keep the draft per conversation while switching between chats.
  useEffect(() => {
    setText(sessionStorage.getItem(`relay.draft.${id}`) ?? "");
    setPending(null);
  }, [id]);
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(`relay.draft.${id}`, text);
      else sessionStorage.removeItem(`relay.draft.${id}`);
    } catch {
      // Storage unavailable: the draft just isn't kept.
    }
  }, [id, text]);
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  async function attach(file: File) {
    if (lock) return;
    const kind = caps
      ? (["image", "video", "audio", "document"] as const).find((k) =>
          caps.media[k].mimeTypes.includes(file.type),
        )
      : undefined;
    if (!kind || !caps?.outboundTypes.includes(kind)) {
      notify.error(`${file.name} can't be sent here`, {
        description: "Images must be JPG or PNG; documents PDF, Word, Excel, PowerPoint or text.",
      });
      return;
    }
    if (file.size > caps.media[kind].maxBytes) {
      notify.error(`${file.name} is too large`, {
        description: `${kindWord(kind)}s can be up to ${fileSize(caps.media[kind].maxBytes)}.`,
      });
      return;
    }
    setPending({ file, upload: null, error: null });
    try {
      const up = await uploadFile(id, file);
      setPending((p) => (p?.file === file ? { ...p, upload: up } : p));
      input.current?.focus();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The upload failed. Check your connection.";
      setPending((p) => (p?.file === file ? { ...p, error: message } : p));
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: attach reads the latest props on each drop
  useEffect(() => {
    if (!dropped) return;
    void attach(dropped);
    onDroppedHandled();
  }, [dropped]);

  const uploading = !!pending && !pending.upload && !pending.error;
  const canSend =
    !lock && !send.isPending && !uploading && !pending?.error && (!!text.trim() || !!pending?.upload);

  function submitNote() {
    let body = text.trim();
    if (!body || addNote.isPending) return;
    // Longest names first, so "@Priya Shah" wins over "@Priya".
    for (const [name, userId] of [...mentioned.current].sort((a, b) => b[0].length - a[0].length))
      body = body.split(`@${name}`).join(`@[${name}](${userId})`);
    addNote.mutate(body, {
      onError: (err) =>
        notify.error("Note not added", {
          description: err instanceof ApiError ? err.message : "Check your connection and try again.",
        }),
    });
    setText("");
    mentioned.current.clear();
    setToken(null);
  }

  function submit() {
    if (note) return submitNote();
    if (!canSend) return;
    const body = text.trim();
    if (caps && body.length > caps.maxTextLength) {
      notify.error(`Messages can be up to ${caps.maxTextLength} characters.`);
      return;
    }
    send.mutate(
      {
        text: body || undefined,
        upload: pending?.upload ?? undefined,
        replyToMessageId: replyTo?.id,
        senderName: me.user.name,
      },
      {
        onError: (err) =>
          notify.error("Message not sent", {
            description: err instanceof ApiError ? err.message : "Check your connection and try again.",
          }),
      },
    );
    setText("");
    typing(""); // the next reply signals "typing…" afresh
    setPending(null);
    onClearReply();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggesting) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggestions.length || 1;
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && suggestions[active]) {
        e.preventDefault();
        pick(suggestions[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setToken(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const noteButton = detail.canWork ? (
    <Button size="sm" variant="outline" onClick={() => setMode("note")}>
      <Icon name="lock" />
      Write a note
    </Button>
  ) : null;

  if (lock && !note) {
    if (windowOnly && canTemplate)
      return (
        <div className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3 sm:flex-row sm:items-center">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Icon name="clock" size="sm" />
          </span>
          <p className="flex-1 text-sm text-muted-foreground">{lock}</p>
          {noteButton}
          <Button size="sm" onClick={() => setPicking(true)}>
            <Icon name="file" />
            Choose a template
          </Button>
          {pickerDialog}
        </div>
      );
    return (
      <div className="flex items-start gap-3 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        <Icon name="lock" size="sm" className="mt-0.5 shrink-0" />
        <p className="flex-1">{lock}</p>
        {noteButton}
      </div>
    );
  }

  const closingSoon =
    !!detail.conversation.windowExpiresAt &&
    new Date(detail.conversation.windowExpiresAt).getTime() - now < 60 * 60_000;

  return (
    <div className="relative flex flex-col gap-1.5">
      {suggesting ? (
        <SuggestionList
          title={note ? "Mention a teammate" : "Quick replies"}
          items={suggestions}
          active={Math.min(active, Math.max(0, suggestions.length - 1))}
          onPick={pick}
          onHover={setActive}
          empty={
            note
              ? team.isPending
                ? "Loading…"
                : "No teammate by that name works on this branch."
              : quick.isPending
                ? "Loading…"
                : quick.data?.length
                  ? "No quick reply matches."
                  : "No quick replies yet."
          }
          footer={
            note ? undefined : (
              <Link href="/settings/quick-replies" className="text-primary hover:underline">
                Manage quick replies
              </Link>
            )
          }
        />
      ) : null}
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border bg-card p-2 transition-colors focus-within:border-primary",
          note &&
            "border-amber-300 bg-amber-50 focus-within:border-amber-500 dark:border-amber-500/40 dark:bg-amber-500/10",
        )}
      >
        {replyTo ? (
          <div className="flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted px-2.5 py-1.5 text-xs">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                Replying to{" "}
                {replyTo.direction === "outbound" ? "your message" : (replyTo.sender.name ?? "the customer")}
              </p>
              <p className="truncate text-muted-foreground">
                {(replyTo.content.text as string | undefined) ?? kindWord(replyTo.type)}
              </p>
            </div>
            <button
              type="button"
              aria-label="Cancel reply"
              onClick={onClearReply}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <Icon name="close" size="sm" />
            </button>
          </div>
        ) : null}
        {pending ? (
          <Attachment
            size="sm"
            state={pending.error ? "error" : pending.upload ? "done" : "uploading"}
            className="w-fit max-w-full"
          >
            <AttachmentMedia variant={pending.upload?.kind === "image" ? "image" : "icon"}>
              {pending.upload?.kind === "image" ? (
                // biome-ignore lint/performance/noImgElement: a local preview of the uploaded file
                <img src={pending.upload.url} alt="" />
              ) : uploading ? (
                <Spinner />
              ) : (
                <Icon name={pending.error ? "alert" : "file"} />
              )}
            </AttachmentMedia>
            <AttachmentContent className="min-w-0">
              <AttachmentTitle className="max-w-56 truncate">{pending.file.name}</AttachmentTitle>
              <AttachmentDescription className={pending.error ? "text-destructive" : undefined}>
                {pending.error ?? (uploading ? "Uploading…" : fileSize(pending.file.size))}
              </AttachmentDescription>
            </AttachmentContent>
            <button
              type="button"
              aria-label="Remove file"
              onClick={() => setPending(null)}
              className="ml-1 rounded-sm p-1 text-muted-foreground hover:text-foreground"
            >
              <Icon name="close" size="sm" />
            </button>
          </Attachment>
        ) : null}
        <label htmlFor="reply-box" className="sr-only">
          Reply
        </label>
        <TextArea
          id="reply-box"
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const caret = e.target.selectionStart ?? e.target.value.length;
            setToken(tokenAtCaret(e.target.value, caret, note ? "@" : "/"));
            setActive(0);
            if (note) {
              if (e.target.value.trim()) reportTyping(id);
            } else onTyping(e.target.value);
          }}
          onKeyDown={onKeyDown}
          minRows={1}
          maxRows={8}
          placeholder={
            note
              ? "Add an internal note — only your team sees this. Type @ to mention someone."
              : pending
                ? "Add a caption"
                : `Message ${detail.conversation.title}`
          }
          className="border-0 bg-transparent px-1.5 py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-1">
          {detail.canWork ? (
            <Segmented
              size="sm"
              aria-label="Reply or internal note"
              value={mode}
              onChange={(m) => {
                setMode(m);
                setToken(null);
                input.current?.focus();
              }}
              options={[
                { value: "reply", label: "Reply" },
                { value: "note", label: "Note", icon: <Icon name="lock" size="xs" /> },
              ]}
              className="mr-1"
            />
          ) : null}
          {note ? (
            <span className="ml-1 hidden truncate text-xs text-amber-800 sm:inline dark:text-amber-200/80">
              Only your team sees notes
            </span>
          ) : (
            <>
              <input
                ref={picker}
                type="file"
                className="hidden"
                accept={
                  caps
                    ? Object.values(caps.media)
                        .flatMap((m) => m.mimeTypes)
                        .join(",")
                    : undefined
                }
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void attach(f);
                }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Attach a file"
                    disabled={!!pending}
                    onClick={() => picker.current?.click()}
                  >
                    <Icon name="attach" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Attach a photo, video, audio or document</TooltipContent>
              </Tooltip>
              {caps?.outboundTypes.includes("audio") && caps.media.audio.mimeTypes.includes("audio/ogg") ? (
                <VoiceRecorder
                  conversationId={id}
                  disabled={!!pending || !!lock || send.isPending}
                  onRecorded={(up) =>
                    send.mutate(
                      { upload: up, replyToMessageId: replyTo?.id, senderName: me.user.name },
                      {
                        onError: (err) =>
                          notify.error("Voice note not sent", {
                            description:
                              err instanceof ApiError ? err.message : "Check your connection and try again.",
                          }),
                        onSuccess: () => onClearReply(),
                      },
                    )
                  }
                />
              ) : null}
              {detail.conversation.kind === "direct" && !lock ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Send items from the catalogue"
                      onClick={() => setPickingItems(true)}
                    >
                      <Icon name="tag" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Send items</TooltipContent>
                </Tooltip>
              ) : null}
              {detail.conversation.kind === "direct" ? (
                <ItemPicker conversationId={id} open={pickingItems} onOpenChange={setPickingItems} />
              ) : null}
              {canTemplate ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Send a template"
                      onClick={() => setPicking(true)}
                    >
                      <Icon name="file" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Send a template</TooltipContent>
                </Tooltip>
              ) : null}
              <span
                className={cn(
                  "ml-1 inline-flex items-center gap-1 text-xs",
                  closingSoon ? "font-medium text-warning" : "text-muted-foreground",
                )}
              >
                <Icon name="clock" size="xs" />
                Reply window: {left}
              </span>
            </>
          )}
          {note ? (
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              disabled={!text.trim() || addNote.isPending}
              onClick={submit}
            >
              {addNote.isPending ? <Spinner /> : <Icon name="lock" />}
              Add note
            </Button>
          ) : (
            <Button type="button" size="sm" className="ml-auto" disabled={!canSend} onClick={submit}>
              {send.isPending ? <Spinner /> : <Icon name="send" />}
              Send
            </Button>
          )}
        </div>
      </div>
      <p className="hidden px-1 text-[11px] text-muted-foreground sm:block">
        {note
          ? "Enter to add the note · Shift + Enter for a new line · @ to mention a teammate"
          : "Enter to send · Shift + Enter for a new line · / for quick replies · drop a file to attach it"}
      </p>
      {pickerDialog}
    </div>
  );
}
