"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Mode = "system" | "light" | "dark";
const KEY = "kairos-theme";

function apply(mode: Mode) {
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** System, light or dark; remembered in this browser. */
export function ThemeSwitch() {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    try {
      setMode((localStorage.getItem(KEY) as Mode) || "system");
    } catch {}
  }, []);
  useEffect(() => {
    if (mode !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => apply("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mode]);
  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {}
    apply(m);
  };
  const options = [
    { value: "system" as const, label: "Match the system", Icon: Monitor },
    { value: "light" as const, label: "Light", Icon: Sun },
    { value: "dark" as const, label: "Dark", Icon: Moon },
  ];
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg border bg-card p-0.5">
      {options.map(({ value, label, Icon }) => (
        // biome-ignore lint/a11y/useSemanticElements: icon-only segmented control acting as a radio group
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          aria-label={label}
          title={label}
          onClick={() => choose(value)}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground",
            mode === value && "bg-secondary text-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** The Kairos mark: a dial with its one opportune moment. */
export function KairosMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="9" className="fill-foreground" />
      <path
        d="M9.2 20.8a8.6 8.6 0 1 1 13.6 0"
        fill="none"
        strokeWidth="2.4"
        strokeLinecap="round"
        className="stroke-background/45"
      />
      <path
        d="M9.2 20.8a8.6 8.6 0 0 1 4.3-11.3"
        fill="none"
        strokeWidth="2.4"
        strokeLinecap="round"
        className="stroke-primary"
      />
      <circle cx="16" cy="16" r="2.4" className="fill-background" />
      <path d="M16 16 20.6 11.4" strokeWidth="2.2" strokeLinecap="round" className="stroke-background" />
    </svg>
  );
}
