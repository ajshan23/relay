"use client";

import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";

export type ChoiceOption<TValue extends string = string> = {
  value: TValue;
  label: React.ReactNode;
  /** Optional icon shown before the label. */
  icon?: React.ReactNode;
  disabled?: boolean;
};

export type SegmentedProps<TValue extends string = string> = {
  options: ReadonlyArray<ChoiceOption<TValue>>;
  value: TValue;
  onChange: (value: TValue) => void;
  /** md is 36px tall (default), sm is 32px. */
  size?: "sm" | "md";
  /** Names the group for screen readers, e.g. "Period". */
  "aria-label": string;
  /** Stretch to the container width with equal segments. */
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
};

/**
 * A segmented control for switching between two to five views of the same thing (Day / Week,
 * List / Board). Acts as a radio group: arrow keys move between options.
 */
export function Segmented<TValue extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  fullWidth,
  disabled,
  className,
  "aria-label": ariaLabel,
}: SegmentedProps<TValue>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented"
      aria-label={ariaLabel}
      orientation="horizontal"
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        const match = options.find((o) => o.value === v);
        if (match) onChange(match.value);
      }}
      className={cn(
        "rounded-lg bg-muted p-0.5",
        fullWidth ? "flex w-full" : "inline-flex w-fit",
        disabled && "opacity-60",
        className,
      )}
    >
      {options.map((o) => (
        <RadioGroupPrimitive.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-md px-3 font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:bg-card data-[state=checked]:text-foreground data-[state=checked]:shadow-sm [&_svg]:size-4 [&_svg]:shrink-0",
            size === "sm" ? "h-7 text-[13px]" : "h-8 text-sm",
            fullWidth && "flex-1",
          )}
        >
          {o.icon}
          {o.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}

export type FilterPillOption<TValue extends string = string> = ChoiceOption<TValue> & {
  /** Shown after the label, muted. */
  count?: number;
};

export type FilterPillsProps<TValue extends string = string> = {
  options: ReadonlyArray<FilterPillOption<TValue>>;
  value: TValue;
  onChange: (value: TValue) => void;
  /** Names the group for screen readers, e.g. "Filter chats". */
  "aria-label": string;
  /** "muted" (default) for pills on a card, "outline" for pills on the page background. */
  variant?: "muted" | "outline";
  className?: string;
};

/**
 * A single-select row of pills for quick filters above a list or table (All / Needs a person /
 * Mine). Scrolls sideways on narrow screens. For switching views rather than filtering, use `Segmented`.
 */
export function FilterPills<TValue extends string = string>({
  options,
  value,
  onChange,
  variant = "muted",
  className,
  "aria-label": ariaLabel,
}: FilterPillsProps<TValue>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="filter-pills"
      aria-label={ariaLabel}
      orientation="horizontal"
      value={value}
      onValueChange={(v) => {
        const match = options.find((o) => o.value === v);
        if (match) onChange(match.value);
      }}
      className={cn("scroll-thin flex gap-1.5 overflow-x-auto", className)}
    >
      {options.map((o) => (
        <RadioGroupPrimitive.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-transparent px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background [&_svg]:size-4 [&_svg]:shrink-0",
            variant === "muted" ? "bg-muted" : "border-border bg-card",
          )}
        >
          {o.icon}
          {o.label}
          {o.count !== undefined ? <span className="tabular-nums opacity-70">{o.count}</span> : null}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}

type RowProps = {
  label: React.ReactNode;
  /** A muted line under the label. */
  description?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  /** Form field name, for native form submission. */
  name?: string;
  className?: string;
};

export type SwitchRowProps = RowProps & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/**
 * A settings row with a label, an optional description and a switch on the right. Clicking
 * anywhere on the row toggles it. Use for on/off settings that apply immediately.
 */
export function SwitchRow({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  id: idProp,
  name,
  className,
}: SwitchRowProps) {
  const generated = React.useId();
  const id = idProp ?? generated;
  return (
    <label
      htmlFor={id}
      data-slot="switch-row"
      data-disabled={disabled || undefined}
      className={cn(
        "flex cursor-pointer items-center justify-between gap-4 py-2.5 text-sm data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60",
        className,
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span id={`${id}-label`} className="font-medium text-foreground">
          {label}
        </span>
        {description ? (
          <span id={`${id}-description`} className="text-[13px] text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      <Switch
        id={id}
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
      />
    </label>
  );
}

export type CheckboxRowProps = RowProps & {
  /** "indeterminate" shows a partial state, e.g. for a "select all" row. */
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/**
 * A checkbox with a label and an optional description; the whole row toggles it. Use for
 * options that are saved with a form, or for picking several items from a short list.
 */
export function CheckboxRow({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  id: idProp,
  name,
  className,
}: CheckboxRowProps) {
  const generated = React.useId();
  const id = idProp ?? generated;
  return (
    <label
      htmlFor={id}
      data-slot="checkbox-row"
      data-disabled={disabled || undefined}
      className={cn(
        "flex cursor-pointer items-start gap-3 py-2 text-sm data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60",
        className,
      )}
    >
      <Checkbox
        id={id}
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(state) => onCheckedChange?.(state === true)}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        className="mt-0.5"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span id={`${id}-label`} className="leading-5 font-medium text-foreground">
          {label}
        </span>
        {description ? (
          <span id={`${id}-description`} className="text-[13px] text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
