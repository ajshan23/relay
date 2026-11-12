"use client";

import { TooltipProvider } from "@relay/ui/ui/tooltip";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { AskBar } from "./ask-bar";
import { CommandPalette } from "./command-palette";
import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";

/**
 * The Board shell: sidebar, a scrolling content area and the assistant bar docked under it.
 * The page itself never scrolls; only the content area does.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = () => setPaletteOpen(true);
  const showAskBar = !(pathname === "/conversations" || pathname.startsWith("/conversations/"));

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <Sidebar onOpenPalette={openPalette} />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileNav onOpenPalette={openPalette} />
          <main className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</main>
          {showAskBar ? <AskBar /> : null}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </TooltipProvider>
  );
}
