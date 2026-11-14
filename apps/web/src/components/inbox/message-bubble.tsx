"use client";

import { Icon } from "@relay/ui/components/icon";
import { Person } from "@relay/ui/components/person";
import { Button } from "@relay/ui/ui/button";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "@relay/ui/ui/message";
import { Popover, PopoverContent, PopoverTrigger } from "@relay/ui/ui/popover";
import { type ReactNode, useState } from "react";
import { ChatBubble } from "@/components/ui/whatsapp/chat-bubble";
import { ContactBubble } from "@/components/ui/whatsapp/contact-bubble";
import { FileAttachmentBubble } from "@/components/ui/whatsapp/file-attachment-bubble";
import { ImageBubble } from "@/components/ui/whatsapp/image-bubble";
import { LocationBubble } from "@/components/ui/whatsapp/location-bubble";
import type { MessageStatus } from "@/components/ui/whatsapp/message-status";
import { MessageText } from "@/components/ui/whatsapp/message-text";
import { ReactionsDisplay } from "@/components/ui/whatsapp/reaction";
import { ReplyPreview } from "@/components/ui/whatsapp/reply-preview";
import { StickerBubble } from "@/components/ui/whatsapp/sticker-bubble";
import { TemplateBubble, type TemplateButton } from "@/components/ui/whatsapp/template-bubble";
import { UnsupportedMessageBubble } from "@/components/ui/whatsapp/unsupported-message-bubble";
import { VideoBubble } from "@/components/ui/whatsapp/video-bubble";
import { VoiceMessageBubble } from "@/components/ui/whatsapp/voice-message-bubble";
import { cn } from "@/lib/utils";
import { clockTime, failureText, fileSize, kindWord } from "./format";
import type { Message as Msg } from "./types";

/*
 * Renders one message with the wa-ui bubbles (components/ui/whatsapp, MIT). Relay's own behaviour sits
 * around them: avatars and names in groups, the reply button, reactions, failures with "Try again".
 */

type Props = {
  message: Msg;
  /** Deletes an internal note; given only for notes the viewer may delete. */
  onDeleteNote?: (m: Msg) => void;
  /** First message of a run from the same sender: shows the name (and avatar in groups). */
  first: boolean;
  /** Last message of a run: the bubble gets its tail. */
  last: boolean;
  isGroup: boolean;
  onRetry?: (m: Msg) => void;
  onReply?: (m: Msg) => void;
  /** React with an emoji, or "" to take our reaction away. Only while the reply window is open. */
  onReact?: (m: Msg, emoji: string) => void;
};

/** Relay's delivery states → the bubble's ticks. Inbound messages show none. */
function tickStatus(m: Msg): MessageStatus | undefined {
  if (m.direction === "inbound") return undefined;
  switch (m.status) {
    case "queued":
    case "sending":
      return "sending";
    case "delivered":
      return "delivered";
    case "read":
    case "played":
      return "read";
    case "failed":
      return "failed";
    default:
      return "sent";
  }
}

/** Group members' names get a steady colour each, so a busy group is easy to follow. */
const memberColours = ["#1f7aec", "#06a88e", "#d97706", "#e11d74", "#7c3aed", "#0891b2"];
function memberColour(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return memberColours[h % memberColours.length];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** "@[Priya Shah](user_1)" in a note, shown as a highlighted "@Priya Shah". */
function NoteText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/@\[([^\]]{1,80})\]\(([\w-]{1,60})\)/g)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <span
        key={at}
        className="rounded bg-amber-500/20 px-0.5 font-medium text-amber-900 dark:text-amber-200"
      >
        @{match[1]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <p className="text-sm whitespace-pre-wrap break-words">{parts}</p>;
}

/** An internal note: for the team only, never sent to the customer. */
function NoteCard({ message: m, onDelete }: { message: Msg; onDelete?: (m: Msg) => void }) {
  return (
    <div className="group/row px-1 py-1" data-message-id={m.id}>
      <div className="mx-auto w-full max-w-xl rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-50">
        <div className="mb-1 flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-200/80">
          <Icon name="lock" size="xs" />
          <span className="font-medium">Note · {m.sender.name ?? "Teammate"}</span>
          <span>· only your team sees this</span>
          <span className="ml-auto tabular-nums">{clockTime(m.sentAt)}</span>
          {onDelete && !m.pending ? (
            <button
              type="button"
              aria-label="Delete note"
              onClick={() => onDelete(m)}
              className="inline-flex size-5 items-center justify-center rounded opacity-0 outline-none group-hover/row:opacity-100 hover:bg-amber-500/20 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Icon name="delete" size="xs" />
            </button>
          ) : null}
        </div>
        <NoteText text={str(m.content.text) ?? ""} />
      </div>
    </div>
  );
}

export function MessageBubble({
  message: m,
  first,
  last,
  isGroup,
  onRetry,
  onReply,
  onReact,
  onDeleteNote,
}: Props) {
  if (m.type === "note") return <NoteCard message={m} onDelete={onDeleteNote} />;
  const out = m.direction === "outbound";
  const failed = m.status === "failed";
  const memberName = isGroup && !out ? (m.sender.name ?? "Member") : null;
  // Teammates' names sit above their runs; text bubbles show group members' names inside.
  const nameAbove = first && ((out && !!m.sender.name) || (!!memberName && m.type !== "text"));
  const outsideReactions = m.reactions.length > 0 && m.type !== "text";
  return (
    <Message align={out ? "end" : "start"} className="group/row px-1" data-message-id={m.id}>
      {isGroup && !out ? (
        <MessageAvatar className={cn("size-8 self-end", !last && "invisible")}>
          <Person name={m.sender.name ?? "?"} size="md" decorative />
        </MessageAvatar>
      ) : null}
      <MessageContent className="gap-0.5">
        {nameAbove ? (
          <MessageHeader
            className={cn("px-1", out && "justify-end")}
            style={memberName ? { color: memberColour(m.sender.id ?? memberName) } : undefined}
          >
            {out ? m.sender.name : memberName}
          </MessageHeader>
        ) : null}
        {/* Every bubble kind sits on its sender's side (only the text bubble aligns itself), with the
            reply button right next to it. The width limit is ours, so the library's 60% is lifted. */}
        <div
          className={cn("flex w-full min-w-0", out ? "justify-end" : "justify-start")}
          style={{ "--wa-msg-max-width": "100%" } as React.CSSProperties}
        >
          <div
            className={cn(
              "flex max-w-[min(85%,34rem)] min-w-0 items-center gap-1",
              out && "flex-row-reverse",
            )}
          >
            <div className={cn("relative min-w-0", m.pending && "opacity-80")}>
              <Body message={m} last={last} first={first} memberName={memberName} />
              {outsideReactions ? (
                <div className={cn("absolute -bottom-3 z-10", out ? "right-3" : "left-3")}>
                  <ReactionsDisplay reactions={m.reactions.map((r) => ({ emoji: r.emoji }))} />
                </div>
              ) : null}
            </div>
            {onReact && !m.pending && !failed && (!out || !["queued", "sending"].includes(m.status)) ? (
              <ReactButton message={m} onReact={onReact} />
            ) : null}
            {onReply && !m.pending ? (
              <button
                type="button"
                aria-label="Reply to this message"
                onClick={() => onReply(m)}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity outline-none group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Icon name="reply" size="sm" />
              </button>
            ) : null}
          </div>
        </div>
        {outsideReactions ? <div className="h-3" /> : null}
        {failed ? (
          <MessageFooter className="flex-wrap gap-x-2 px-1 text-destructive">
            <span className="font-normal">{failureText(m)}</span>
            {onRetry ? (
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0 text-destructive"
                onClick={() => onRetry(m)}
              >
                Try again
              </Button>
            ) : null}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}

/** The quoted message shown above a reply. */
function quoteOf(m: Msg): ReactNode {
  if (!m.replyTo) return null;
  const t = m.replyTo.type;
  const mediaType =
    t === "contacts"
      ? "contact"
      : (["image", "video", "audio", "document", "sticker", "location"] as const).find((x) => x === t);
  return (
    <ReplyPreview
      author={m.replyTo.direction === "outbound" ? "You" : (m.replyTo.senderName ?? "Customer")}
      body={m.replyTo.text ?? kindWord(t)}
      mediaType={mediaType}
    />
  );
}

function Body({
  message: m,
  last,
  first,
  memberName,
}: {
  message: Msg;
  last: boolean;
  first: boolean;
  memberName: string | null;
}) {
  const variant = m.direction === "outbound" ? "outgoing" : "incoming";
  const c = m.content;
  const file = m.attachments[0];
  const ready = file?.status === "stored" ? file.url : undefined;
  const media = c.media as Record<string, unknown> | undefined;
  const caption = str(c.caption) ?? str(media?.caption) ?? undefined;
  const common = { variant, timestamp: clockTime(m.sentAt), status: tickStatus(m), showTail: last } as const;
  const quote = quoteOf(m);

  // Media still downloading (or failed) shows a calm note in a normal bubble.
  const pendingMedia = (what: string) => (
    <ChatBubble {...common}>
      {quote}
      <span className="flex items-center gap-2 text-wa-text-secondary">
        <Icon name={file?.status === "failed" ? "alert" : "loading"} size="sm" />
        {file?.status === "failed" ? `${what} couldn't be downloaded` : `Getting the ${what.toLowerCase()}…`}
      </span>
    </ChatBubble>
  );

  switch (m.type) {
    case "text":
      return (
        <ChatBubble
          {...common}
          isGroupChat={!!memberName}
          sender={first ? (memberName ?? undefined) : undefined}
          senderColor={memberName ? memberColour(m.sender.id ?? memberName) : undefined}
          reactions={m.reactions.length ? m.reactions.map((r) => ({ emoji: r.emoji })) : undefined}
        >
          {quote}
          <MessageText text={str(c.text) ?? ""} />
        </ChatBubble>
      );
    case "image":
      return ready ? (
        <ImageBubble
          {...common}
          // The chat shows a small preview; clicking opens the full photo.
          src={`${ready}?preview=1`}
          alt={caption ?? "Photo"}
          caption={caption}
          quote={quote}
          onMediaClick={() => window.open(ready, "_blank", "noopener")}
        />
      ) : (
        pendingMedia("Photo")
      );
    case "sticker":
      return ready ? <StickerBubble {...common} src={ready} alt="Sticker" /> : pendingMedia("Sticker");
    case "video":
      return ready ? (
        <VideoBubble
          {...common}
          src={ready}
          // A still frame until play (when one could be made; otherwise the full photo endpoint
          // returns the video itself, which a poster can't show, so only pass it when known).
          poster={file?.hasPreview ? `${ready}?preview=1` : undefined}
          caption={caption}
          quote={quote}
        />
      ) : (
        pendingMedia("Video")
      );
    case "audio":
      return ready ? (
        <VoiceMessageBubble {...common} audioSrc={ready} duration="0:00" quote={quote} />
      ) : (
        pendingMedia("Voice message")
      );
    case "document": {
      const name = str(media?.fileName) ?? file?.fileName ?? "Document";
      return (
        <FileAttachmentBubble
          {...common}
          fileName={name}
          fileSize={fileSize(file?.sizeBytes) || undefined}
          fileType={name.includes(".") ? name.split(".").pop() : undefined}
          caption={caption}
          quote={quote}
          downloadUrl={ready}
          downloadStatus={ready ? "idle" : "downloading"}
        />
      );
    }
    case "location":
      return (
        <LocationBubble
          {...common}
          quote={quote}
          name={str(c.name) ?? undefined}
          address={str(c.address) ?? undefined}
          latitude={Number(c.latitude) || 0}
          longitude={Number(c.longitude) || 0}
          mapsUrl={str(c.url) ?? undefined}
        />
      );
    case "contacts": {
      const people =
        (c.contacts as { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[] | undefined) ??
        [];
      return (
        <ContactBubble
          {...common}
          quote={quote}
          contacts={people.map((p) => ({
            name: p.name?.formatted_name ?? "Contact",
            phones: (p.phones ?? []).map((x) => x.phone ?? "").filter(Boolean),
          }))}
        />
      );
    }
    case "template": {
      const h = c.header as { kind?: string; text?: string; attachmentId?: string | null } | null | undefined;
      const buttons =
        (c.buttons as { kind?: string; text?: string; url?: string; phone?: string }[] | undefined) ?? [];
      return (
        <TemplateBubble
          {...common}
          label={
            c.test
              ? `Test${str(c.broadcastName) ? ` · ${str(c.broadcastName)}` : ""}`
              : str(c.broadcastName)
                ? `Broadcast · ${str(c.broadcastName)}`
                : undefined
          }
          header={
            !h
              ? undefined
              : h.kind === "text"
                ? { type: "text", text: h.text }
                : h.kind === "image"
                  ? {
                      type: "image",
                      imageUrl: h.attachmentId ? `/api/attachments/${h.attachmentId}` : undefined,
                    }
                  : h.kind === "video"
                    ? { type: "video" }
                    : { type: "document", documentName: "Document" }
          }
          body={str(c.body) ?? ""}
          footer={str(c.footer) ?? undefined}
          buttons={buttons.map(
            (b): TemplateButton =>
              b.kind === "link"
                ? { type: "url", label: b.text ?? "", url: b.url }
                : b.kind === "call"
                  ? { type: "phone_number", label: b.text ?? "", phone_number: b.phone }
                  : b.kind === "copy"
                    ? { type: "copy_code", label: b.text ?? "Copy code" }
                    : { type: "quick_reply", label: b.text ?? "" },
          )}
        />
      );
    }
    case "interactive":
    case "button":
      return (
        <ChatBubble
          {...common}
          isGroupChat={!!memberName}
          sender={first ? (memberName ?? undefined) : undefined}
        >
          {quote}
          <span className="mr-1.5 text-xs text-wa-text-secondary">Tapped</span>
          {str(c.title) ?? str(c.text) ?? str(c.name) ?? "a reply"}
        </ChatBubble>
      );
    case "order":
      return (
        <ChatBubble {...common}>
          <span className="flex items-center gap-2">
            <Icon name="tag" size="sm" />
            Order · {((c.items as unknown[]) ?? []).length} items
          </span>
        </ChatBubble>
      );
    default:
      return (
        <UnsupportedMessageBubble
          {...common}
          title="This message can't be shown here yet"
          description="Open the channel's own app to see it."
        />
      );
  }
}

const quickReactions = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** The smiley next to a message: six quick reactions; our current one is marked, and picking it again removes it. */
function ReactButton({ message: m, onReact }: { message: Msg; onReact: (m: Msg, emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const mine = m.reactions.find((r) => r.mine)?.emoji ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={mine ? `Change your reaction (${mine})` : "React to this message"}
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity outline-none group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50",
            open && "opacity-100",
          )}
        >
          <Icon name="emoji" size="sm" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="flex w-auto gap-0.5 rounded-full p-1">
        {quickReactions.map((e) => (
          <button
            key={e}
            type="button"
            aria-label={e === mine ? `Remove your ${e} reaction` : `React ${e}`}
            aria-pressed={e === mine}
            onClick={() => {
              setOpen(false);
              onReact(m, e === mine ? "" : e);
            }}
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-full text-xl transition-transform outline-none hover:scale-110 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
              e === mine && "bg-primary/15",
            )}
          >
            {e}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
