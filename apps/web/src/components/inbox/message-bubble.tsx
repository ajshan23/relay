"use client";

import { Icon } from "@relay/ui/components/icon";
import { Person } from "@relay/ui/components/person";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@relay/ui/ui/attachment";
import { Bubble, BubbleContent, BubbleReactions } from "@relay/ui/ui/bubble";
import { Button } from "@relay/ui/ui/button";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "@relay/ui/ui/message";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relay/ui/ui/tooltip";
import { cn } from "@/lib/utils";
import { clockTime, failureText, fileSize, kindWord } from "./format";
import type { Attachment as File, Message as Msg } from "./types";

type Props = {
  message: Msg;
  /** First message of a run from the same sender: shows the name (and avatar in groups). */
  first: boolean;
  /** Last message of a run: shows the time and ticks. */
  last: boolean;
  isGroup: boolean;
  onRetry?: (m: Msg) => void;
  onReply?: (m: Msg) => void;
};

/** One message, built on shadcn Message and Bubble. Outbound on the right in the brand colour. */
export function MessageBubble({ message: m, first, last, isGroup, onRetry, onReply }: Props) {
  const out = m.direction === "outbound";
  const media = ["image", "video", "sticker"].includes(m.type);
  const failed = m.status === "failed";
  const showName = first && (out ? !!m.sender.name : isGroup);
  return (
    <Message
      align={out ? "end" : "start"}
      className={cn("group/row", !last && "pb-0")}
      data-message-id={m.id}
    >
      {isGroup && !out ? (
        <MessageAvatar className={cn("size-8 self-end", !last && "invisible")}>
          <Person name={m.sender.name ?? "?"} size="md" decorative />
        </MessageAvatar>
      ) : null}
      <MessageContent className="gap-1">
        {showName ? (
          <MessageHeader className={cn("px-1", out && "justify-end")}>
            {out ? `${m.sender.name}` : (m.sender.name ?? "Member")}
          </MessageHeader>
        ) : null}
        <div className={cn("flex max-w-full items-center gap-1", out && "flex-row-reverse")}>
          <Bubble
            align={out ? "end" : "start"}
            variant={failed ? "destructive" : out ? "default" : "outline"}
            className={cn("max-w-[min(80%,34rem)]", m.reactions.length && "mb-3", m.pending && "opacity-80")}
          >
            <BubbleContent className={cn("rounded-lg", media && "p-1")}>
              {m.replyTo ? <Quote quote={m.replyTo} out={out} /> : null}
              <Body message={m} out={out} />
            </BubbleContent>
            {m.reactions.length ? (
              <BubbleReactions align={out ? "start" : "end"} className="text-xs">
                {m.reactions.map((r) => (
                  <Tooltip key={`${r.by ?? "?"}-${r.emoji}`}>
                    <TooltipTrigger asChild>
                      <span>{r.emoji}</span>
                    </TooltipTrigger>
                    <TooltipContent>{r.by ?? "Customer"}</TooltipContent>
                  </Tooltip>
                ))}
              </BubbleReactions>
            ) : null}
          </Bubble>
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
        ) : last ? (
          <MessageFooter className="gap-1 px-1 font-normal">
            <time dateTime={m.sentAt} className="tabular-nums">
              {clockTime(m.sentAt)}
            </time>
            {out ? <Ticks message={m} isGroup={isGroup} /> : null}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}

function Ticks({ message: m, isGroup }: { message: Msg; isGroup: boolean }) {
  const map = {
    queued: { icon: "clock", label: "Sending" },
    sending: { icon: "clock", label: "Sending" },
    accepted: { icon: "check", label: "Sent" },
    sent: { icon: "check", label: "Sent" },
    delivered: { icon: "checkDouble", label: "Delivered" },
    read: { icon: "checkDouble", label: "Read" },
    played: { icon: "checkDouble", label: "Played" },
    failed: { icon: "alert", label: "Not sent" },
    received: { icon: "check", label: "Sent" },
  } as const;
  const t = map[m.status];
  const seen = m.status === "read" || m.status === "played";
  const groupNote =
    isGroup && m.receipts ? ` · read by ${m.receipts.read}, delivered to ${m.receipts.delivered}` : "";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", seen ? "text-primary" : "text-muted-foreground")}>
          <Icon name={t.icon} size="xs" label={t.label} />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {t.label}
        {groupNote}
      </TooltipContent>
    </Tooltip>
  );
}

function Quote({ quote, out }: { quote: NonNullable<Msg["replyTo"]>; out: boolean }) {
  return (
    <div
      className={cn(
        "mb-1.5 rounded-sm border-l-2 px-2 py-1 text-xs",
        out ? "border-primary-foreground/60 bg-primary-foreground/10" : "border-primary bg-muted",
      )}
    >
      <p className="font-medium">{quote.direction === "outbound" ? "You" : "Customer"}</p>
      <p className="line-clamp-2 opacity-80">{quote.text ?? kindWord(quote.type)}</p>
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

function Body({ message: m, out }: { message: Msg; out: boolean }) {
  const c = m.content;
  const file = m.attachments[0];
  const media = c.media as Record<string, unknown> | undefined;
  const caption = str(c.caption) ?? str(media?.caption);
  const captionEl = caption ? <p className="px-2 pt-1.5 pb-0.5 whitespace-pre-wrap">{caption}</p> : null;

  switch (m.type) {
    case "text":
      return <p className="whitespace-pre-wrap">{str(c.text)}</p>;
    case "image":
    case "sticker":
      return (
        <>
          <MediaFrame file={file} kind={m.type}>
            {(f) => (
              <a href={f.url} target="_blank" rel="noreferrer" className="block">
                {/* biome-ignore lint/performance/noImgElement: private, access-checked media; next/image can't proxy it */}
                <img
                  src={f.url}
                  alt={caption ?? kindWord(m.type)}
                  loading="lazy"
                  className={cn(
                    "rounded-md object-cover",
                    m.type === "sticker" ? "size-32 object-contain" : "max-h-80 w-full max-w-72",
                  )}
                />
              </a>
            )}
          </MediaFrame>
          {captionEl}
        </>
      );
    case "video":
      return (
        <>
          <MediaFrame file={file} kind="video">
            {(f) => (
              // biome-ignore lint/a11y/useMediaCaption: customer videos come without captions
              <video
                src={f.url}
                controls
                preload="metadata"
                className="max-h-80 w-full max-w-72 rounded-md"
              />
            )}
          </MediaFrame>
          {captionEl}
        </>
      );
    case "audio":
      return (
        <MediaFrame file={file} kind="audio">
          {/* biome-ignore lint/a11y/useMediaCaption: voice notes have no captions */}
          {(f) => <audio src={f.url} controls preload="metadata" className="h-10 w-64 max-w-full" />}
        </MediaFrame>
      );
    case "document":
      return (
        <>
          <DocumentCard file={file} name={str(media?.fileName) ?? file?.fileName ?? "Document"} out={out} />
          {captionEl}
        </>
      );
    case "location": {
      const lat = c.latitude as number;
      const lng = c.longitude as number;
      const href = str(c.url) ?? `https://maps.google.com/?q=${lat},${lng}`;
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="flex items-start gap-2 underline-offset-2 hover:underline"
        >
          <Icon name="location" className="mt-0.5 shrink-0" />
          <span>
            <span className="block font-medium">{str(c.name) ?? "Shared location"}</span>
            {str(c.address) ? <span className="block text-xs opacity-80">{str(c.address)}</span> : null}
          </span>
        </a>
      );
    }
    case "interactive":
    case "button":
      return (
        <p>
          <span className="mr-1.5 text-xs opacity-70">Tapped</span>
          {str(c.title) ?? str(c.text) ?? str(c.name) ?? "a reply"}
        </p>
      );
    case "contacts": {
      const people = (c.contacts as { name?: { formatted_name?: string } }[] | undefined) ?? [];
      return (
        <p className="flex items-center gap-2">
          <Icon name="user" size="sm" />
          {people
            .map((p) => p.name?.formatted_name)
            .filter(Boolean)
            .join(", ") || "Contact card"}
        </p>
      );
    }
    case "order":
      return (
        <p className="flex items-center gap-2">
          <Icon name="tag" size="sm" />
          Order · {((c.items as unknown[]) ?? []).length} items
        </p>
      );
    default:
      return (
        <p className="flex items-center gap-2 text-sm italic opacity-80">
          <Icon name="blocked" size="sm" />
          This kind of message can't be shown here yet.
        </p>
      );
  }
}

/** Shows the file once it is stored, a placeholder while it downloads, and a note when it failed. */
function MediaFrame({
  file,
  kind,
  children,
}: {
  file: File | undefined;
  kind: string;
  children: (f: File) => React.ReactNode;
}) {
  if (file?.status === "stored") return <>{children(file)}</>;
  const failed = !file || file.status === "failed";
  return (
    <div className="flex h-24 w-56 max-w-full flex-col items-center justify-center gap-1.5 rounded-md bg-muted text-xs text-muted-foreground">
      <Icon name={failed ? "alert" : "loading"} />
      {failed ? `${kindWord(kind)} couldn't be downloaded` : `Getting the ${kindWord(kind).toLowerCase()}…`}
    </div>
  );
}

function DocumentCard({ file, name, out }: { file: File | undefined; name: string; out: boolean }) {
  const ready = file?.status === "stored";
  return (
    <Attachment
      size="sm"
      state={file?.status === "failed" ? "error" : ready ? "done" : "processing"}
      className={cn("min-w-56 border-0", out ? "bg-primary-foreground/10 text-inherit" : "bg-muted")}
    >
      <AttachmentMedia className={out ? "bg-primary-foreground/15 text-inherit" : "bg-card"}>
        <Icon name={file?.status === "failed" ? "alert" : "file"} />
      </AttachmentMedia>
      <AttachmentContent className="min-w-0">
        <AttachmentTitle className="truncate">{name}</AttachmentTitle>
        <AttachmentDescription className={out ? "text-inherit opacity-75" : undefined}>
          {file?.status === "failed"
            ? "Couldn't be downloaded"
            : ready
              ? [fileSize(file?.sizeBytes), file?.mimeType === "application/pdf" ? "PDF" : null]
                  .filter(Boolean)
                  .join(" · ")
              : "Downloading…"}
        </AttachmentDescription>
      </AttachmentContent>
      {ready && file ? (
        <a
          href={file.url}
          download={name}
          aria-label={`Download ${name}`}
          className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:bg-white/10"
        >
          <Icon name="download" size="sm" />
        </a>
      ) : null}
    </Attachment>
  );
}
