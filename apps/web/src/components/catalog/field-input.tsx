"use client";

import { Field } from "@relay/ui/components/field";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { Checkbox } from "@relay/ui/ui/checkbox";
import type { CatalogField } from "./queries";

/** The input for one catalogue field, by its type. `value` is the stored value (or a draft string). */
export function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: CatalogField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const label = field.unit ? `${field.label} (${field.unit})` : field.label;
  const text = value === null || value === undefined ? "" : String(value);
  switch (field.type) {
    case "boolean":
      return (
        <Field label={label} required={field.required}>
          <SelectField
            value={value === true ? "yes" : value === false ? "no" : ""}
            onValueChange={(v) => onChange(v === "yes" ? true : v === "no" ? false : null)}
            placeholder="Not set"
            disabled={disabled}
            options={[
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ]}
          />
        </Field>
      );
    case "select":
      return (
        <Field label={label} required={field.required}>
          <SelectField
            value={text}
            onValueChange={(v) => onChange(v || null)}
            placeholder="Choose"
            disabled={disabled}
            options={field.options.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>
      );
    case "multi_select": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">
            {label}
            {field.required ? <span className="text-destructive"> *</span> : null}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {field.options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={chosen.includes(o.value)}
                  disabled={disabled}
                  onCheckedChange={(on) =>
                    onChange(on ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))
                  }
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case "number":
      return (
        <Field label={label} required={field.required}>
          <TextInput
            inputMode="decimal"
            value={text}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          />
        </Field>
      );
    case "date":
      return (
        <Field label={label} required={field.required}>
          <TextInput
            type="date"
            value={text}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value || null)}
          />
        </Field>
      );
    default:
      return (
        <Field label={label} required={field.required}>
          <TextInput
            type={field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
            inputMode={field.type === "phone" ? "tel" : undefined}
            value={text}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value || null)}
          />
        </Field>
      );
  }
}

/** A short text for a stored value, for lists. */
export function fieldValueLabel(field: CatalogField, value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const label = (v: unknown) => field.options.find((o) => o.value === v)?.label ?? String(v);
  if (field.type === "boolean") return value ? "Yes" : "No";
  if (field.type === "select") return label(value);
  if (field.type === "multi_select") return (Array.isArray(value) ? value : [value]).map(label).join(", ");
  if (field.type === "number") return `${value}${field.unit ? ` ${field.unit}` : ""}`;
  return String(value);
}
