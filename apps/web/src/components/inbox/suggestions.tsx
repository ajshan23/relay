"use client";

import { cn } from "@/lib/utils";

/*
 * The small list that opens above the reply box while typing "@" (teammates, in a note) or "/" (quick
 * replies). The reply box keeps focus and owns the keys: ↑/↓ move, Enter or Tab picks, Esc closes.
 */

export type Suggestion = { id: string; label: string; hint?: string; detail?: string };

export function SuggestionList({
  items,
  active,
  onPick,
  onHover,
  title,
  footer,
  empty,
}: {
  items: Suggestion[];
  active: number;
  onPick: (item: Suggestion) => void;
  onHover: (index: number) => void;
  title: string;
  footer?: React.ReactNode;
  empty: string;
}) {
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
      <p className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">{title}</p>
      {items.length ? (
        <div role="listbox" aria-label={title} className="max-h-64 overflow-y-auto py-1">
          {items.map((item, i) => (
            <div
              key={item.id}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              // Keep the reply box focused: pick on mouse down.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item);
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-sm",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <span className="flex items-baseline gap-2">
                <span className="truncate font-medium">{item.label}</span>
                {item.hint ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>
                ) : null}
              </span>
              {item.detail ? (
                <span className="truncate text-xs text-muted-foreground">{item.detail}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground">{empty}</p>
      )}
      {footer ? <div className="border-t px-3 py-1.5 text-xs">{footer}</div> : null}
    </div>
  );
}

/** The word being typed right before the caret, if it starts with `trigger` ("@" or "/"). */
export function tokenAtCaret(text: string, caret: number, trigger: "@" | "/") {
  const before = text.slice(0, caret);
  const re = trigger === "@" ? /(^|\s)@([^\s@]{0,30})$/ : /(^|\n)\/([\w-]{0,30})$/;
  const m = re.exec(before);
  if (!m) return null;
  const start = before.length - (m[2]?.length ?? 0) - 1;
  return { query: (m[2] ?? "").toLowerCase(), start, end: caret };
}
