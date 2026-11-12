"use client";

import * as React from "react";
import { cn } from "../lib/utils";
import { Label } from "../ui/label";

/** Props handed to the control so the label, hint and error are wired to it. */
export type FieldControlProps = {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
};

type ControlElementProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
};

export type FieldProps = {
  /** Visible label. Always give one; use `hideLabel` when the context already labels it visually. */
  label: React.ReactNode;
  /** Helper text under the control. */
  hint?: React.ReactNode;
  /** Error text. When set the control is marked invalid and the message is announced. */
  error?: React.ReactNode;
  /** Adds a required marker to the label. */
  required?: boolean;
  /** Shows "Optional" next to the label. Ignored when `required` is set. */
  optional?: boolean;
  /** "stacked" puts the label above the control; "inline" puts it beside the control on wider screens. */
  layout?: "stacked" | "inline";
  /** Keeps the label for screen readers only. */
  hideLabel?: boolean;
  /** Use your own id for the control; one is generated otherwise. */
  id?: string;
  className?: string;
  /** A single control element, or a render function that receives the wiring props. */
  children: React.ReactElement<ControlElementProps> | ((control: FieldControlProps) => React.ReactNode);
};

/**
 * The wrapper every form control sits in. Use it for any labelled input, select, textarea or
 * switch so the label, hint and error are tied to the control for screen readers.
 */
export function Field({
  label,
  hint,
  error,
  required,
  optional,
  layout = "stacked",
  hideLabel,
  id: idProp,
  className,
  children,
}: FieldProps) {
  const generatedId = React.useId();
  const id = idProp ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const describedBy =
    [hint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(" ") || undefined;

  const control: FieldControlProps = {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": hasError ? true : undefined,
  };

  let content: React.ReactNode;
  if (typeof children === "function") {
    content = children(control);
  } else {
    const own = children.props;
    content = React.cloneElement(children, {
      id: own.id ?? control.id,
      "aria-describedby":
        [own["aria-describedby"], control["aria-describedby"]].filter(Boolean).join(" ") || undefined,
      "aria-invalid": own["aria-invalid"] ?? control["aria-invalid"],
    });
  }

  const inline = layout === "inline";

  return (
    <div
      data-slot="field"
      data-invalid={hasError || undefined}
      className={cn(
        "flex flex-col gap-1.5",
        inline && "sm:grid sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-start sm:gap-x-6",
        className,
      )}
    >
      <Label htmlFor={id} className={cn(inline && "sm:min-h-9", hideLabel && "sr-only")}>
        <span>
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-0.5 text-destructive">
              *
            </span>
          ) : null}
        </span>
        {optional && !required ? (
          <span className="text-xs font-normal text-muted-foreground">Optional</span>
        ) : null}
      </Label>
      <div className="flex min-w-0 flex-col gap-1.5">
        {content}
        {hint ? (
          <p id={hintId} className="text-[13px] text-muted-foreground">
            {hint}
          </p>
        ) : null}
        {hasError ? (
          <p id={errorId} role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Stacks fields with the standard vertical rhythm. Use it for the body of any form or form section. */
export function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("flex flex-col gap-5", className)} {...props} />;
}

/**
 * The button row at the end of a form. Put the primary action last; it aligns to the end by default.
 */
export function FormActions({
  align = "end",
  className,
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" | "between" }) {
  return (
    <div
      data-slot="form-actions"
      className={cn(
        "flex flex-wrap items-center gap-2 pt-2",
        align === "end" && "justify-end",
        align === "start" && "justify-start",
        align === "between" && "justify-between",
        className,
      )}
      {...props}
    />
  );
}
