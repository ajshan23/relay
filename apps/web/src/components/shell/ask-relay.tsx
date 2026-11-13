"use client";

import { Icon } from "@relay/ui/components/icon";
import { Bubble, BubbleContent } from "@relay/ui/ui/bubble";
import { Button } from "@relay/ui/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@relay/ui/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@relay/ui/ui/input-group";
import { Message, MessageContent } from "@relay/ui/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@relay/ui/ui/message-scroller";
import { Popover, PopoverAnchor, PopoverContent } from "@relay/ui/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relay/ui/ui/tooltip";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const suggestions = [
  "Draft a win-back campaign",
  "This week's chats by branch",
  "Make Mira's replies shorter",
  "Who's waiting longest?",
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
  const form = useRef<HTMLFormElement>(null);

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
      form.current?.requestSubmit();
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

        {/* shadcn suggestion pattern: your words in a muted bubble, Relay's reply as plain text. */}
        <div className="h-72">
          {asked.length ? (
            <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent className="gap-4 px-4 py-3 text-sm">
                    {asked.map((t) => (
                      <MessageScrollerItem
                        key={t.id}
                        messageId={String(t.id)}
                        className="flex flex-col gap-3"
                      >
                        <Message align="end">
                          <MessageContent>
                            <Bubble align="end" variant="muted">
                              <BubbleContent>{t.text}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                        <Message>
                          <MessageContent>
                            <p className="text-muted-foreground">
                              Got it. The assistant arrives with the AI agent; your request is kept here until
                              then.
                            </p>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ))}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton className="bottom-2" />
              </MessageScroller>
            </MessageScrollerProvider>
          ) : (
            <Empty className="h-full border-0 p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Icon name="sparkles" />
                </EmptyMedia>
                <EmptyTitle className="text-base">What do you need?</EmptyTitle>
                <EmptyDescription>
                  Ask for a campaign, a report or a change to Mira in plain words. Pick a suggestion to start.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t p-3">
          <div className="scroll-thin flex gap-2 overflow-x-auto pb-0.5">
            {suggestions.map((s) => (
              <Button key={s} variant="outline" size="sm" className="shrink-0" onClick={() => ask(s)}>
                {s}
              </Button>
            ))}
          </div>
          <form
            ref={form}
            onSubmit={(e) => {
              e.preventDefault();
              ask(text);
            }}
          >
            <InputGroup>
              <InputGroupTextarea
                ref={field}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Tell Relay what you need"
                aria-label="Ask Relay"
                className="max-h-32 min-h-11 p-3"
              />
              <InputGroupAddon align="block-end">
                <InputGroupText className="text-xs">Enter to send</InputGroupText>
                <InputGroupButton
                  type="submit"
                  size="icon-sm"
                  variant="default"
                  className="ml-auto rounded-full"
                  disabled={!text.trim()}
                  aria-label="Send"
                >
                  <Icon name="arrowUp" />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}
