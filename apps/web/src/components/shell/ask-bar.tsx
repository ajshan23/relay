"use client";

import { Button } from "@relay/ui/ui/button";
// Icons: imported from lucide-react until the shared Icon component lands.
import { ArrowUp } from "lucide-react";
import { useId } from "react";

/** The assistant bar docked under the content. The assistant itself comes later. */
export function AskBar({ onAsk }: { onAsk?: (question: string) => void }) {
  const id = useId();
  return (
    <div className="shrink-0 px-5 pt-2 pb-4 sm:px-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const field = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
          const question = field.value.trim();
          field.value = "";
          if (question) onAsk?.(question);
        }}
        className="mx-auto flex h-12 max-w-3xl items-center gap-2 rounded-full border bg-card pr-1.5 pl-4 shadow-soft focus-within:border-primary"
      >
        <span
          aria-hidden="true"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground"
        >
          R
        </span>
        <label className="sr-only" htmlFor={id}>
          Ask Relay
        </label>
        <input
          id={id}
          name="q"
          autoComplete="off"
          placeholder="Tell Relay what you need: a campaign, a report, a change to Mira"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <kbd className="hidden rounded-md border px-1.5 font-sans text-[11px] text-muted-foreground sm:inline">
          Enter
        </kbd>
        <Button type="submit" size="icon-sm" aria-label="Send" className="rounded-full">
          <ArrowUp />
        </Button>
      </form>
    </div>
  );
}
