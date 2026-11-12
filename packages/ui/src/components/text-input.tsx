"use client";

import { SearchIcon, XIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

type ControlSize = "sm" | "md";

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export type TextInputProps = Omit<React.ComponentProps<"input">, "size"> & {
  /** Icon or text inside the field, before the value (decorative; keep the label on the Field). */
  leading?: React.ReactNode;
  /** Icon, unit or small button inside the field, after the value. */
  trailing?: React.ReactNode;
  /** md is 36px tall (default), sm is 32px for toolbars and dense rows. */
  size?: ControlSize;
  /** Class for the outer wrapper when a slot is used. `className` goes on the input itself. */
  wrapperClassName?: string;
};

/**
 * A single-line text field. Use it inside a `Field` for names, emails, numbers and any short text.
 * Add `leading` for an icon and `trailing` for a unit or an inline action.
 */
export function TextInput({
  leading,
  trailing,
  size = "md",
  className,
  wrapperClassName,
  ...props
}: TextInputProps) {
  const sized = size === "sm" ? "h-8 px-2.5 text-[13px] md:text-[13px]" : "h-9";
  if (leading === undefined && trailing === undefined) {
    return <Input data-size={size} className={cn(sized, className)} {...props} />;
  }
  return (
    <div data-slot="text-input" className={cn("relative w-full", wrapperClassName)}>
      {leading !== undefined ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 flex items-center text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0",
            size === "sm" ? "pl-2.5" : "pl-3",
          )}
        >
          {leading}
        </span>
      ) : null}
      <Input
        data-size={size}
        className={cn(
          sized,
          leading !== undefined && (size === "sm" ? "pl-8" : "pl-9"),
          trailing !== undefined && (size === "sm" ? "pr-8" : "pr-9"),
          className,
        )}
        {...props}
      />
      {trailing !== undefined ? (
        <span
          className={cn(
            "absolute inset-y-0 right-0 flex items-center text-sm text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0",
            size === "sm" ? "pr-1" : "pr-1.5",
          )}
        >
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

export type TextAreaProps = Omit<React.ComponentProps<"textarea">, "rows"> & {
  /** Rows shown when empty. Defaults to 3. */
  minRows?: number;
  /** The field grows with its content up to this many rows, then scrolls. Defaults to 8. */
  maxRows?: number;
};

/**
 * A multi-line text field that grows with its content. Use it for messages, notes and
 * descriptions; for one line use `TextInput`.
 */
export function TextArea({ minRows = 3, maxRows = 8, className, ref, onChange, ...props }: TextAreaProps) {
  const inner = React.useRef<HTMLTextAreaElement | null>(null);

  const resize = React.useCallback(() => {
    const el = inner.current;
    if (!el) return;
    const style = window.getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const max = line * maxRows + padding + border;
    const min = line * minRows + padding + border;
    el.style.height = "auto";
    const natural = el.scrollHeight + border;
    el.style.height = `${Math.max(min, Math.min(natural, max))}px`;
    el.style.overflowY = natural > max ? "auto" : "hidden";
  }, [maxRows, minRows]);

  // Re-measure when a controlled value changes from outside.
  // biome-ignore lint/correctness/useExhaustiveDependencies: props.value is the trigger, not a dependency of resize
  React.useLayoutEffect(() => {
    resize();
  }, [resize, props.value]);

  return (
    <Textarea
      rows={minRows}
      ref={(node) => {
        inner.current = node;
        setRef(ref, node);
      }}
      onChange={(e) => {
        onChange?.(e);
        resize();
      }}
      className={cn("scroll-thin min-h-0 resize-none [field-sizing:fixed]", className)}
      {...props}
    />
  );
}

export type SearchInputProps = Omit<
  TextInputProps,
  "leading" | "trailing" | "type" | "value" | "defaultValue" | "onChange"
> & {
  value?: string;
  defaultValue?: string;
  /** Called on every keystroke and on clear. */
  onValueChange?: (value: string) => void;
  /** Called after typing pauses for `debounceMs`, and immediately on clear or Enter. */
  onSearch?: (value: string) => void;
  /** Delay before `onSearch` fires. Defaults to 300ms. */
  debounceMs?: number;
};

/**
 * A search box with a search icon and a clear button. Use it above lists and tables to filter.
 * Give it an `aria-label` (defaults to "Search") when there is no visible label.
 */
export function SearchInput({
  value: valueProp,
  defaultValue = "",
  onValueChange,
  onSearch,
  debounceMs = 300,
  size = "md",
  ref,
  onKeyDown,
  placeholder = "Search",
  "aria-label": ariaLabel = "Search",
  ...props
}: SearchInputProps) {
  const [inner, setInner] = React.useState(defaultValue);
  const controlled = valueProp !== undefined;
  const value = controlled ? valueProp : inner;
  const input = React.useRef<HTMLInputElement | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSearchRef = React.useRef(onSearch);
  onSearchRef.current = onSearch;

  React.useEffect(() => () => clearTimeout(timer.current), []);

  function change(next: string, immediate: boolean) {
    if (!controlled) setInner(next);
    onValueChange?.(next);
    clearTimeout(timer.current);
    if (immediate) onSearchRef.current?.(next);
    else timer.current = setTimeout(() => onSearchRef.current?.(next), debounceMs);
  }

  return (
    <TextInput
      type="search"
      role="searchbox"
      size={size}
      autoComplete="off"
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={value}
      ref={(node) => {
        input.current = node;
        setRef(ref, node);
      }}
      onChange={(e) => change(e.target.value, false)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Escape" && value) {
          e.preventDefault();
          change("", true);
        } else if (e.key === "Enter") {
          e.preventDefault();
          change(value, true);
        }
      }}
      className="[&::-webkit-search-cancel-button]:appearance-none"
      leading={<SearchIcon />}
      trailing={
        value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              change("", true);
              input.current?.focus();
            }}
            className={cn(
              "inline-flex items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/20",
              size === "sm" ? "size-6" : "size-7",
            )}
          >
            <XIcon />
          </button>
        ) : undefined
      }
      {...props}
    />
  );
}
