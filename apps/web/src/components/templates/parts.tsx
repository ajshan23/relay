"use client";

import {
  fillVariables,
  type TemplateContent,
  type TemplateStatus,
  type TemplateVariable,
} from "@relay/core/templates";
import { Icon, type IconName } from "@relay/ui/components/icon";
import { Tag, type Tone } from "@relay/ui/components/tag";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relay/ui/ui/tooltip";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ChannelCopy } from "./queries";

export const statusLook: Record<TemplateStatus, { label: string; tone: Tone; icon: IconName }> = {
  draft: { label: "Draft", tone: "plain", icon: "edit" },
  in_review: { label: "In review", tone: "warning", icon: "clock" },
  ready: { label: "Ready", tone: "good", icon: "check" },
  needs_changes: { label: "Needs a change", tone: "danger", icon: "alert" },
  paused: { label: "Paused", tone: "warning", icon: "pause" },
  disabled: { label: "Turned off", tone: "danger", icon: "blocked" },
};

/** One chip per channel: where this template can be used, and where it is waiting. */
export function ChannelStatus({ copy, estimate }: { copy: ChannelCopy; estimate?: string | null }) {
  const look = statusLook[copy.status];
  const tip =
    copy.status === "in_review"
      ? `${copy.channelName} is reviewing it${estimate ? `; this usually takes ${estimate}` : ""}. We'll update it here.`
      : copy.status === "needs_changes" || copy.status === "paused"
        ? (copy.reason ?? `${copy.channelName} asked for a change.`)
        : copy.status === "ready"
          ? `Ready to send on ${copy.channelName}.`
          : copy.channelName;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Tag tone={look.tone} size="sm" icon={look.icon}>
            <span className="max-w-36 truncate">{copy.channelName}</span>
            <span className="opacity-70">· {look.label}</span>
          </Tag>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** The message text with details shown as soft highlights (examples filled in when given). */
function Highlighted({ text, examples }: { text: string; examples: Record<string, string> }) {
  const parts = text.split(/(\{\{\s*[a-zA-Z0-9_]+\s*\}\})/g);
  return (
    <>
      {parts.map((p, i) => {
        // Pieces of one string, split in order; their position is their identity.
        const key = `${i}:${p}`;
        const m = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(p);
        if (!m) return <Fragment key={key}>{p}</Fragment>;
        const name = (m[1] ?? "").toLowerCase();
        const value = examples[name];
        return (
          <span key={key} className="rounded-sm bg-primary/12 px-0.5 font-medium text-primary">
            {value?.trim() ? value : name.replace(/_/g, " ")}
          </span>
        );
      })}
    </>
  );
}

/**
 * How the customer will see it: a chat bubble on a phone-like screen. Channel-neutral on purpose;
 * the same message goes to every channel the business picks.
 */
export function MessagePreview({
  content,
  variables,
  headerUrl,
  className,
  caption,
}: {
  content: TemplateContent;
  variables: TemplateVariable[];
  headerUrl?: string | null;
  className?: string;
  caption?: ReactNode;
}) {
  const examples = Object.fromEntries(variables.map((v) => [v.name, v.example]));
  const empty = !content.body.trim() && !content.header && !content.footer && !content.buttons.length;
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div className="w-full max-w-[300px] overflow-hidden rounded-[28px] border-[6px] border-foreground/85 bg-muted shadow-sm">
        <div className="flex items-center gap-2 bg-card px-3 py-2.5 text-xs">
          <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
            B
          </span>
          <span className="font-semibold">Your business</span>
        </div>
        <div
          className="min-h-72 px-3 py-4"
          style={{
            backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }}
        >
          {empty ? (
            <p className="pt-20 text-center text-xs text-muted-foreground">
              Your message appears here as you write.
            </p>
          ) : (
            <div className="w-[92%] overflow-hidden rounded-lg rounded-tl-sm bg-card text-[13px] leading-relaxed shadow-xs">
              {content.header?.kind === "text" && content.header.text.trim() ? (
                <p className="px-3 pt-2.5 font-semibold">
                  <Highlighted text={content.header.text} examples={examples} />
                </p>
              ) : content.header && content.header.kind !== "text" ? (
                headerUrl && content.header.kind === "image" ? (
                  // biome-ignore lint/performance/noImgElement: a private uploaded file
                  <img
                    src={headerUrl}
                    alt=""
                    className="m-1 mb-0 max-h-40 w-[calc(100%-0.5rem)] rounded-md object-cover"
                  />
                ) : (
                  <div className="m-1 mb-0 flex h-24 items-center justify-center gap-2 rounded-md bg-muted text-xs text-muted-foreground">
                    <Icon
                      name={
                        content.header.kind === "document"
                          ? "file"
                          : content.header.kind === "video"
                            ? "video"
                            : "image"
                      }
                    />
                    {content.header.kind === "document"
                      ? "Document"
                      : content.header.kind === "video"
                        ? "Video"
                        : "Picture"}
                  </div>
                )
              ) : null}
              {content.body.trim() ? (
                <p className="px-3 pt-2 pb-1 whitespace-pre-wrap">
                  <Highlighted text={content.body} examples={examples} />
                </p>
              ) : null}
              {content.footer?.trim() ? (
                <p className="px-3 pb-1 text-[11px] text-muted-foreground">{content.footer}</p>
              ) : null}
              <p className="px-3 pb-1.5 text-right text-[10px] text-muted-foreground">10:30</p>
              {content.buttons.map((b, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: buttons are edited in place by position
                  key={i}
                  className="flex items-center justify-center gap-1.5 border-t px-3 py-2 text-[13px] font-medium text-primary"
                >
                  {b.kind === "link" ? (
                    <Icon name="external" size="xs" />
                  ) : b.kind === "call" ? (
                    <Icon name="phone" size="xs" />
                  ) : (
                    <Icon name="reply" size="xs" />
                  )}
                  {b.text || "Button"}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {caption}
    </div>
  );
}

/** A short line of the body with details filled from examples, for lists. */
export function previewLine(content: TemplateContent, variables: TemplateVariable[]) {
  const examples = Object.fromEntries(variables.map((v) => [v.name, v.example]));
  return fillVariables(content.body, examples).replace(/\s+/g, " ").trim();
}
