"use client";

import { type FieldOption, type FieldType, fieldKey, fieldTypes, optionColours } from "@relay/core/contacts";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@relay/ui/ui/popover";
import { type ReactNode, useState } from "react";
import { ApiError } from "@/lib/api";
import { Chip } from "./cells";
import { useContactActions } from "./queries";

const typeOptions = (Object.keys(fieldTypes) as FieldType[]).map((t) => ({
  value: t,
  label: fieldTypes[t].label,
  description: fieldTypes[t].hint,
}));

/** The list of choices for a Single or Multiple choice field, each with a colour. */
export function OptionsEditor({
  options,
  onChange,
}: {
  options: FieldOption[];
  onChange: (o: FieldOption[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const label = draft.trim();
    if (!label || options.some((o) => o.label.toLowerCase() === label.toLowerCase())) return;
    onChange([
      ...options,
      {
        value: fieldKey(label),
        label,
        colour: optionColours[options.length % optionColours.length] ?? "gray",
      },
    ]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      {options.length ? (
        <div className="flex flex-wrap gap-1">
          {options.map((o) => (
            <span key={o.value} className="inline-flex items-center gap-0.5">
              <Chip colour={o.colour}>{o.label}</Chip>
              <button
                type="button"
                aria-label={`Remove ${o.label}`}
                onClick={() => onChange(options.filter((x) => x.value !== o.value))}
                className="rounded text-muted-foreground hover:text-foreground"
              >
                <Icon name="close" size="xs" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <TextInput
        size="sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        placeholder="Type an option, press Enter"
        aria-label="New option"
      />
    </div>
  );
}

/** "+" in the table header (or any trigger): name a field, pick its type, and it becomes a column. */
export function AddFieldPopover({
  trigger,
  onAdded,
}: {
  trigger: ReactNode;
  onAdded?: (key: string) => void;
}) {
  const actions = useContactActions();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState<FieldOption[]>([]);
  const choice = type === "select" || type === "multi_select";

  const reset = () => {
    setLabel("");
    setType("text");
    setOptions([]);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return;
            actions.addField.mutate(
              { label: label.trim(), type, options: choice ? options : undefined },
              {
                onSuccess: ({ field }) => {
                  notify.success(`“${field.label}” added`, {
                    description: "It's now a column in the table.",
                  });
                  onAdded?.(field.key);
                  setOpen(false);
                  reset();
                },
                onError: (err) =>
                  notify.error("Couldn't add the field", {
                    description: err instanceof ApiError ? err.message : undefined,
                  }),
              },
            );
          }}
        >
          <div>
            <p className="text-sm font-medium">Add a field</p>
            <p className="text-xs text-muted-foreground">Anything you want to keep about each contact.</p>
          </div>
          <Field label="Name">
            <TextInput
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Date of birth"
            />
          </Field>
          <Field label="Type">
            <SelectField options={typeOptions} value={type} onValueChange={setType} />
          </Field>
          {choice ? (
            <Field label="Options" hint="You can add more later.">
              {() => <OptionsEditor options={options} onChange={setOptions} />}
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!label.trim() || (choice && !options.length) || actions.addField.isPending}
            >
              Add field
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
