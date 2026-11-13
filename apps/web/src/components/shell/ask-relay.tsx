"use client";

import { Icon } from "@relay/ui/components/icon";
import { TextArea } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@relay/ui/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relay/ui/ui/tooltip";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const suggestions = [
  "Draft a campaign for customers we haven't seen in 6 months",
  "Show this week's conversations by branch",
  "Make Mira's replies shorter and friendlier",
];

type Turn = { id: number; text: string };

/**
 * Ask Relay: a slim tab on the right edge of every page that opens a popup, instead of a bar docked
 * under the content. The assistant itself comes with the AI agent; until then requests are kept here
 * and the popup says so plainly.
 */
export function AskRelay({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [asked, setAsked] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // ⌘J / Ctrl+J opens and closes it from anywhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  function ask(q: string) {
    const question = q.trim();
    if (!question) return;
    setAsked((list) => [...list, { id: Date.now(), text: question }]);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(text);
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div className="pointer-events-none fixed top-1/2 right-0 z-40 -translate-y-1/2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Ask Relay"
                aria-expanded={open}
                onClick={() => onOpenChange(!open)}
                className={cn(
                  "pointer-events-auto flex h-11 w-9 items-center justify-center rounded-l-lg border border-r-0 bg-card text-primary shadow-soft outline-none transition-[width,background-color] duration-200",
                  "hover:w-11 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                  open && "w-11 bg-accent",
                )}
              >
                <Icon name="sparkles" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              Ask Relay <span className="ml-1 opacity-70">⌘J</span>
            </TooltipContent>
          </Tooltip>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="left"
        align="center"
        sideOffset={10}
        className="flex w-[min(420px,calc(100vw-2rem))] flex-col gap-0 p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          field.current?.focus();
        }}
      >
        <div className="flex items-center gap-2.5 border-b px-4 py-3">
          <span className="inline-flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            R
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Ask Relay</p>
            <p className="text-xs text-muted-foreground">
              Campaigns, reports, changes to Mira, in plain words.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Icon name="close" size="sm" />
          </button>
        </div>

        <div className="scroll-thin flex max-h-72 min-h-36 flex-col gap-2 overflow-y-auto px-4 py-3">
          {asked.length ? (
            asked.map((t) => (
              <div key={t.id} className="flex flex-col gap-1.5">
                <p className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {t.text}
                </p>
                <p className="max-w-[90%] rounded-lg rounded-bl-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                  Got it. The assistant arrives with the AI agent; your request is kept here until then.
                </p>
              </div>
            ))
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Try asking</p>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-md border px-3 py-2 text-left text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t p-3">
          <div className="flex items-end gap-2 rounded-lg border bg-background px-2 py-1.5 focus-within:border-primary">
            <label htmlFor="ask-relay" className="sr-only">
              Ask Relay
            </label>
            <TextArea
              id="ask-relay"
              ref={field}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              minRows={1}
              maxRows={5}
              placeholder="Tell Relay what you need"
              className="border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <Button
              size="icon-sm"
              aria-label="Send"
              className="shrink-0 rounded-full"
              onClick={() => ask(text)}
              disabled={!text.trim()}
            >
              <Icon name="arrowUp" />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
