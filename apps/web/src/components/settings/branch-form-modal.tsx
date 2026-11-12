"use client";

import { FieldGroup, FormActions } from "@relay/ui/components/field";
import { Form, FormError, FormField, useZodForm } from "@relay/ui/components/form";
import { Modal } from "@relay/ui/components/modal";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useMemo } from "react";
import { z } from "zod";
import { api, type Branch } from "@/lib/api";
import { browserTimezone, errorText, timezoneOptions } from "./words";

const schema = z.object({
  name: z.string().trim().min(1, "Give the branch a name").max(80, "Keep it under 80 characters"),
  timezone: z.string().min(1, "Pick a timezone"),
});

export type BranchFormModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The branch to edit. Leave empty to add a new branch. */
  branch?: Branch | null;
  onSaved: (branch: Branch) => void | Promise<void>;
};

/** Adds a branch, or renames one and changes its timezone. */
export function BranchFormModal({ open, onOpenChange, branch, onSaved }: BranchFormModalProps) {
  const editing = Boolean(branch);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={editing ? "Edit branch" : "Add a branch"}
      description={
        editing
          ? "Change the name or the timezone. Opening hours and reports use this timezone."
          : "A branch is one shop or location. Each has its own chats, team and hours."
      }
    >
      {/* The Modal body only mounts while open, so the form starts fresh each time. */}
      <BranchForm
        branch={branch ?? null}
        onCancel={() => onOpenChange(false)}
        onSaved={async (saved) => {
          await onSaved(saved);
          onOpenChange(false);
        }}
      />
    </Modal>
  );
}

function BranchForm({
  branch,
  onCancel,
  onSaved,
}: {
  branch: Branch | null;
  onCancel: () => void;
  onSaved: (branch: Branch) => Promise<void>;
}) {
  const initialTimezone = branch?.timezone ?? browserTimezone();
  const options = useMemo(() => timezoneOptions([initialTimezone]), [initialTimezone]);
  const form = useZodForm(schema, {
    defaultValues: { name: branch?.name ?? "", timezone: initialTimezone },
  });

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        try {
          const res = branch
            ? await api<{ branch: Branch }>(`/branches/${branch.id}`, { method: "PATCH", json: values })
            : await api<{ branch: Branch }>("/branches", { method: "POST", json: values });
          notify.success(branch ? "Branch saved" : `${res.branch.name} added`);
          await onSaved(res.branch);
        } catch (err) {
          throw new Error(errorText(err));
        }
      }}
    >
      <FieldGroup>
        <FormField control={form.control} name="name" label="Branch name" required>
          {({ field, control }) => (
            <TextInput {...field} {...control} placeholder="Marina" autoComplete="off" autoFocus />
          )}
        </FormField>
        <FormField
          control={form.control}
          name="timezone"
          label="Timezone"
          hint="Open the list and start typing a city to jump to it."
        >
          {({ field, control }) => (
            <SelectField
              {...control}
              ref={field.ref}
              value={field.value}
              onValueChange={field.onChange}
              onBlur={field.onBlur}
              options={options}
              placeholder="Pick a timezone"
            />
          )}
        </FormField>
        <FormError />
        <FormActions>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">{branch ? "Save changes" : "Add branch"}</Button>
        </FormActions>
      </FieldGroup>
    </Form>
  );
}
