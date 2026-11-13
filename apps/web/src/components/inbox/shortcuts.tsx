"use client";

import { Modal } from "@relay/ui/components/modal";
import { Kbd } from "@relay/ui/ui/kbd";
import { useEffect, useState } from "react";

/*
 * Keyboard shortcuts for the inbox. One listener on the page; keys are ignored while typing in a box
 * (except Esc). Actions that live in other components (assign, snooze, close, note, search) are sent
 * as a "relay:inbox-shortcut" window event with the action's name, and those components listen.
 */

export type ShortcutAction = "assign" | "snooze" | "close" | "note" | "search";

export const sendShortcut = (action: ShortcutAction) =>
  window.dispatchEvent(new CustomEvent("relay:inbox-shortcut", { detail: action }));

const list: { keys: string[]; what: string }[] = [
  { keys: ["J"], what: "Next conversation" },
  { keys: ["K"], what: "Previous conversation" },
  { keys: ["R"], what: "Reply" },
  { keys: ["N"], what: "Write an internal note" },
  { keys: ["E"], what: "Close or reopen" },
  { keys: ["A"], what: "Assign" },
  { keys: ["S"], what: "Snooze" },
  { keys: ["/"], what: "Search conversations" },
  { keys: ["Ctrl", "F"], what: "Search in this conversation" },
  { keys: ["?"], what: "Show these shortcuts" },
];

function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

export function InboxShortcuts({
  ids,
  selected,
  onSelect,
}: {
  /** The conversations in the list, in order. */
  ids: string[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key;
      // Search in this conversation works from anywhere, replacing the browser's find.
      if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === "f" && selected) {
        e.preventDefault();
        sendShortcut("search");
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      // Leave keys alone while a dialog or menu is open.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const move = (step: number) => {
        if (!ids.length) return;
        const at = selected ? ids.indexOf(selected) : -1;
        const next = ids[Math.min(ids.length - 1, Math.max(0, at === -1 ? 0 : at + step))];
        if (next && next !== selected) onSelect(next);
      };
      const run: Record<string, () => void> = {
        j: () => move(1),
        k: () => move(-1),
        "/": () =>
          document.querySelector<HTMLInputElement>('input[aria-label="Search conversations"]')?.focus(),
        "?": () => setHelp(true),
        ...(selected
          ? {
              r: () => document.getElementById("reply-box")?.focus(),
              n: () => sendShortcut("note"),
              e: () => sendShortcut("close"),
              a: () => sendShortcut("assign"),
              s: () => sendShortcut("snooze"),
            }
          : {}),
      };
      const action = run[key === "?" ? "?" : key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ids, selected, onSelect]);

  return (
    <Modal open={help} onOpenChange={setHelp} size="sm" title="Keyboard shortcuts">
      <ul className="flex flex-col gap-2">
        {list.map((s) => (
          <li key={s.what} className="flex items-center justify-between gap-4 text-sm">
            <span>{s.what}</span>
            <span className="flex gap-1">
              {s.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
