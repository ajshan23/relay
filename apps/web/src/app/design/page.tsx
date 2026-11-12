"use client";

import { useState } from "react";
import { AgentScreen, HomeScreen, InboxScreen } from "./screens";
import type { ScreenId } from "./shell";

const screens: { id: ScreenId; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "inbox", label: "Inbox" },
  { id: "agent", label: "Agent" },
];

/** Dev-only page for agreeing the product's structure and tone. Not linked from the app. */
export default function DesignPage() {
  const [screen, setScreen] = useState<ScreenId>("home");
  const [mode, setMode] = useState<"dark" | "light">("dark");

  return (
    <div className="flex h-screen flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-black px-4 py-2 text-sm text-neutral-300">
        <fieldset className="flex items-center gap-1" aria-label="Screen">
          {screens.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={s.id === screen}
              onClick={() => setScreen(s.id)}
              className={`rounded-md px-3 py-1 font-medium ${
                s.id === screen ? "bg-white text-neutral-900" : "hover:bg-neutral-800"
              }`}
            >
              {s.label}
            </button>
          ))}
        </fieldset>
        <fieldset className="flex items-center gap-1" aria-label="Colour mode">
          {(["dark", "light"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mode}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 capitalize ${
                m === mode ? "bg-neutral-700 text-white" : "hover:bg-neutral-800"
              }`}
            >
              {m}
            </button>
          ))}
        </fieldset>
        <p className="hidden text-neutral-500 lg:block">Mock with sample data. Buttons do nothing yet.</p>
      </div>

      <div className="d-root flex min-h-0 flex-1 flex-col" data-mode={mode}>
        {screen === "home" ? <HomeScreen onNavigate={setScreen} /> : null}
        {screen === "inbox" ? <InboxScreen onNavigate={setScreen} /> : null}
        {screen === "agent" ? <AgentScreen onNavigate={setScreen} /> : null}
      </div>
    </div>
  );
}
