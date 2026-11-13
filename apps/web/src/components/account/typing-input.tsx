"use client";

import { cn } from "@relay/ui/lib/utils";
import { Input } from "@relay/ui/ui/input";
import {
  type ComponentProps,
  type CSSProperties,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/*
 * An input where each typed character fades in softly, the way text appears on an iPhone.
 *
 * The real <input> stays in charge (typing, selection, autofill, password managers, form
 * libraries); only its text is made transparent. An exact copy of the text is drawn on top,
 * one span per character, and only newly inserted characters animate. Both layers use the
 * same font with kerning off, so the caret lines up with the drawn text.
 */

type Glyph = { id: number; char: string };

let nextId = 1;

/** Keeps ids for characters that stayed; only inserted characters get new ids (and animate). */
function diffGlyphs(previous: Glyph[], text: string): Glyph[] {
  const old = previous.map((g) => g.char).join("");
  if (old === text) return previous;
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  let endOld = old.length;
  let endNew = text.length;
  while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const inserted = Array.from(text.slice(start, endNew), (char) => ({ id: nextId++, char }));
  return [...previous.slice(0, start), ...inserted, ...previous.slice(endOld)];
}

type Props = ComponentProps<"input"> & {
  /** Draw dots instead of characters, for passwords. */
  mask?: boolean;
  /** Styles for the wrapper; `className` goes on the input itself. */
  wrapperClassName?: string;
  /** Use inside an InputGroup: no border or background of its own. */
  inGroup?: boolean;
};

export function TypingInput({
  mask = false,
  wrapperClassName,
  inGroup = false,
  className,
  ref,
  onChange,
  ...props
}: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const [glyphs, setGlyphs] = useState<Glyph[]>([]);
  const [layer, setLayer] = useState<CSSProperties>({});
  const [scroll, setScroll] = useState(0);
  // Characters present when the field first appears (or is autofilled) should not animate.
  const settled = useRef(false);

  const setRef = useCallback(
    (el: HTMLInputElement | null) => {
      input.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as { current: HTMLInputElement | null }).current = el;
    },
    [ref],
  ) as Ref<HTMLInputElement>;

  const sync = useCallback(() => {
    const el = input.current;
    if (!el) return;
    setGlyphs((previous) => {
      const next = diffGlyphs(previous, el.value);
      if (!settled.current) return next.map((g) => ({ ...g, id: -g.id }));
      return next;
    });
    settled.current = true;
    setScroll(el.scrollLeft);
  }, []);

  // Match the drawn layer to the input's padding and font, and follow every way the value can change.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const style = getComputedStyle(el);
    setLayer({
      left: `calc(${style.paddingLeft} + ${style.borderLeftWidth})`,
      right: `calc(${style.paddingRight} + ${style.borderRightWidth})`,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
    });
    sync();
    // Not "input": updating state from a native input listener makes React re-render the controlled
    // field before its onChange runs, which puts the old value back and swallows the keystroke.
    // Typing is followed through onChange below instead.
    const events = ["scroll", "keyup", "select", "focus", "blur"] as const;
    for (const name of events) el.addEventListener(name, sync);
    // Autofill can fill the value without an input event in some browsers.
    const poll = window.setInterval(() => {
      if (el.value !== (input.current?.dataset.lastValue ?? "")) {
        el.dataset.lastValue = el.value;
        sync();
      }
    }, 400);
    return () => {
      for (const name of events) el.removeEventListener(name, sync);
      window.clearInterval(poll);
    };
  }, [sync]);

  // Controlled values set from code (for example a reset) also update the drawn text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: props.value is the trigger
  useEffect(() => {
    sync();
  }, [props.value, sync]);

  return (
    <div className={cn("relative min-w-0", inGroup && "flex-1 self-stretch", wrapperClassName)}>
      <Input
        ref={setRef}
        data-slot={inGroup ? "input-group-control" : undefined}
        {...props}
        onChange={(e) => {
          onChange?.(e);
          sync();
        }}
        className={cn(
          "text-transparent caret-primary [font-kerning:none] [-webkit-text-fill-color:transparent]",
          "placeholder:[-webkit-text-fill-color:var(--muted-foreground)] selection:bg-primary/20",
          inGroup && "h-full rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0",
          className,
        )}
      />
      <div
        aria-hidden
        style={layer}
        className="pointer-events-none absolute inset-y-0 flex items-center overflow-hidden text-foreground [font-kerning:none]"
      >
        <span className="whitespace-pre" style={{ transform: `translateX(${-scroll}px)` }}>
          {glyphs.map((g) => (
            <span key={g.id} className={g.id > 0 ? "animate-type-in motion-reduce:animate-none" : undefined}>
              {mask ? "•" : g.char}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
