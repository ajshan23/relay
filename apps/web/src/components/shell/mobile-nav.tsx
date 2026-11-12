"use client";

import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
// Icons: imported from lucide-react until the shared Icon component lands.
import { LogOut, Menu, Search, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { sectionForPath, sections } from "./nav-config";
import { ThemeToggle } from "./theme-toggle";

/** The top bar below the md breakpoint, where the sidebar is hidden. */
export function MobileNav({ onOpenPalette }: { onOpenPalette: () => void }) {
  const pathname = usePathname();
  const current = sectionForPath(pathname);
  const router = useRouter();
  const leave = async () => {
    await signOut();
    router.replace("/sign-in");
  };
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-nav-border bg-nav px-3 text-nav-foreground md:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            className="text-nav-foreground hover:bg-nav-active hover:text-nav-foreground"
          >
            <Menu />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          {sections.map((s) => (
            <DropdownMenuItem key={s.id} asChild>
              <Link href={s.href} aria-current={current?.id === s.id ? "page" : undefined}>
                <s.icon />
                {s.label}
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings/branches">
              <Settings />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={leave}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {current?.label ?? (pathname.startsWith("/settings") ? "Settings" : "Relay")}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search or ask Relay"
        onClick={onOpenPalette}
        className="text-nav-muted hover:bg-nav-active hover:text-nav-foreground"
      >
        <Search />
      </Button>
      <ThemeToggle side="bottom" className="size-9" />
    </header>
  );
}
