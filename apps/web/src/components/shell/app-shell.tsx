"use client";

import { TooltipProvider } from "@relay/ui/ui/tooltip";
import { type ReactNode, useState } from "react";
import { AskRelay } from "./ask-relay";
import { CommandPalette } from "./command-palette";
import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";

/**
 * The Board shell: sidebar and a scrolling content area. Ask Relay lives in a tab on the right edge
 * that opens a popup (also from the sidebar and ⌘J). The page itself never scrolls; only the content does.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const openPalette = () => setPaletteOpen(true);
  const openAsk = () => setAskOpen(true);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <Sidebar onOpenPalette={openPalette} onOpenAsk={openAsk} />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileNav onOpenPalette={openPalette} />
          <main className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
      <AskRelay open={askOpen} onOpenChange={setAskOpen} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </TooltipProvider>
  );
}
