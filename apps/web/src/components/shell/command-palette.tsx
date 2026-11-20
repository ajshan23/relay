"use client";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@relay/ui/ui/command";
// Icons: imported from lucide-react until the shared Icon component lands.
import { MapPin, Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { useBranch } from "./branch-context";
import { sections } from "./nav-config";
import { useSectionAccess } from "./use-sections";

/** Cmd/Ctrl+K: go to a section, switch branch, switch theme. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const { branches, setBranch } = useBranch();
  const allowed = useSectionAccess();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const run = (fn: () => void) => () => {
    fn();
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search or jump to"
      description="Go to a section, switch branch or change the colour theme."
    >
      <CommandInput placeholder="Search or jump to" />
      <CommandList>
        <CommandEmpty>No match.</CommandEmpty>
        <CommandGroup heading="Go to">
          {sections
            .filter((s) => allowed(s.id))
            .map((s) => (
              <CommandItem key={s.id} value={`go to ${s.label}`} onSelect={run(() => router.push(s.href))}>
                <s.icon />
                {s.label}
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandGroup heading="Branch">
          {branches.map((b) => (
            <CommandItem key={b.id} value={`branch ${b.name}`} onSelect={run(() => setBranch(b.id))}>
              <MapPin />
              Switch to {b.name}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Theme">
          <CommandItem value="theme light" onSelect={run(() => setTheme("light"))}>
            <Sun />
            Light theme
          </CommandItem>
          <CommandItem value="theme dark" onSelect={run(() => setTheme("dark"))}>
            <Moon />
            Dark theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
