"use client";

import { Check, MapPin, Palette, PanelsTopLeft, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { LabBar } from "@/components/lab-bar";
import { LinearShell } from "@/components/linear";
import {
  AssistantShell,
  BriefingShell,
  ConsoleShell,
  DockShell,
  LedgerShell,
  MessengerShell,
  TopbarShell,
} from "@/components/shells";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { TooltipProvider } from "@/components/ui/tooltip";
import { branches, pages, suggestions } from "@/lib/data";
import { LabProvider, useLab } from "@/lib/store";
import { type StructureId, structures, themes } from "@/lib/themes";

const shells: Record<StructureId, () => React.ReactNode> = {
  linear: LinearShell,
  ledger: LedgerShell,
  assistant: AssistantShell,
  console: ConsoleShell,
  messenger: MessengerShell,
  briefing: BriefingShell,
  topbar: TopbarShell,
  dock: DockShell,
};

function CommandPalette() {
  const lab = useLab();
  const [query, setQuery] = useState("");
  const run = (fn: () => void) => () => {
    fn();
    lab.setPalette(false);
    setQuery("");
  };
  return (
    <CommandDialog
      open={lab.palette}
      onOpenChange={lab.setPalette}
      title="Search or jump to"
      description="Go to a page, or change branch, structure or colour."
    >
      <CommandInput placeholder="Ask Relay, or search" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No match.</CommandEmpty>
        <CommandGroup heading="Ask Relay">
          {query.trim() ? (
            <CommandItem value={`ask relay ${query}`} onSelect={run(() => lab.ask(query))}>
              <Sparkles />
              Ask: {query}
            </CommandItem>
          ) : (
            suggestions.map((q) => (
              <CommandItem key={q} value={`ask relay ${q}`} onSelect={run(() => lab.ask(q))}>
                <Sparkles />
                {q}
              </CommandItem>
            ))
          )}
        </CommandGroup>
        <CommandGroup heading="Go to">
          {pages.map((p) => (
            <CommandItem key={p.id} onSelect={run(() => lab.go(p.id))}>
              <p.icon />
              {p.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Branch">
          {branches.map((b) => (
            <CommandItem key={b} onSelect={run(() => lab.setBranch(b))}>
              <MapPin />
              Switch to {b}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Structure">
          {structures.map((s) => (
            <CommandItem key={s.id} onSelect={run(() => lab.setStructure(s.id))}>
              <PanelsTopLeft />
              {s.name} structure
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Colour">
          {themes.map((t) => (
            <CommandItem key={t.id} onSelect={run(() => lab.setTheme(t.id))}>
              <Palette />
              {t.name} colours
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function Root() {
  const lab = useLab();
  const Shell = shells[lab.structure];
  const { setPalette, palette } = lab;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(!palette);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, setPalette]);

  return (
    <div className="flex h-dvh flex-col">
      <LabBar />
      <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
        <Shell />
      </div>
      <CommandPalette />
      {lab.toast ? (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-50 inline-flex h-10 -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-medium text-background shadow-2xl"
        >
          <Check className="size-4" />
          {lab.toast}
        </div>
      ) : null}
    </div>
  );
}

export function Lab() {
  return (
    <LabProvider>
      <TooltipProvider delayDuration={200}>
        <Root />
      </TooltipProvider>
    </LabProvider>
  );
}
