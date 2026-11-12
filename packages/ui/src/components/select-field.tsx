"use client";

import type * as React from "react";
import { cn } from "../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export type SelectOption<TValue extends string = string> = {
  value: TValue;
  label: React.ReactNode;
  /** A second, muted line shown in the menu only. */
  description?: React.ReactNode;
  disabled?: boolean;
};

export type SelectFieldProps<TValue extends string = string> = {
  options: ReadonlyArray<SelectOption<TValue>>;
  value?: TValue;
  defaultValue?: TValue;
  onValueChange?: (value: TValue) => void;
  placeholder?: string;
  /** md is 36px tall (default), sm is 32px. */
  size?: "sm" | "md";
  disabled?: boolean;
  required?: boolean;
  /** Form field name, for native form submission. */
  name?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  /** Fires when the menu closes, for touch/blur validation. */
  onBlur?: () => void;
  className?: string;
  contentClassName?: string;
  ref?: React.Ref<HTMLButtonElement>;
};

/**
 * A select for the common case: pick one value from a short, fixed list. Put it inside a `Field`
 * (which wires the id and errors). For long or searchable lists use a combobox instead.
 */
export function SelectField<TValue extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Select",
  size = "md",
  disabled,
  required,
  name,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  onBlur,
  className,
  contentClassName,
  ref,
}: SelectFieldProps<TValue>) {
  const hasDescriptions = options.some((o) => o.description !== undefined);
  return (
    <Select
      value={value}
      defaultValue={defaultValue}
      onValueChange={(v) => {
        const match = options.find((o) => o.value === v);
        if (match) onValueChange?.(match.value);
      }}
      onOpenChange={(open) => {
        if (!open) onBlur?.();
      }}
      disabled={disabled}
      required={required}
      name={name}
    >
      <SelectTrigger
        ref={ref}
        id={id}
        size={size === "sm" ? "sm" : "default"}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className={cn(
          "w-full [&_[data-slot=select-option-description]]:hidden",
          size === "sm" && "text-[13px]",
          className,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className={cn("max-h-80", contentClassName)}>
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            textValue={typeof o.label === "string" ? o.label : undefined}
            className={cn(hasDescriptions && "items-start")}
          >
            {o.description !== undefined ? (
              <span className="flex flex-col gap-0.5">
                <span>{o.label}</span>
                <span data-slot="select-option-description" className="text-xs text-muted-foreground">
                  {o.description}
                </span>
              </span>
            ) : (
              o.label
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
