"use client";

import { cn } from "@relay/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relay/ui/ui/tooltip";
// Icons: imported from lucide-react until the shared Icon component lands.
import { Moon, Sun, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** True only after hydration, so the server HTML and the first client render match. */
function useHydrated() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/** Switches between the FlowFlex light and dark colour designs. */
export function ThemeToggle({
  className,
  side = "top",
}: {
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const hydrated = useHydrated();
  const dark = hydrated && resolvedTheme === "dark";
  const label = !hydrated ? "Switch colour theme" : dark ? "Switch to light theme" : "Switch to dark theme";
  const Icon = !hydrated ? SunMoon : dark ? Sun : Moon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => setTheme(dark ? "light" : "dark")}
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-nav-muted hover:bg-nav-active hover:text-nav-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            className,
          )}
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
