"use client";

import { FieldGroup, FormActions } from "@relay/ui/components/field";
import { Form, FormError, FormField, useZodForm } from "@relay/ui/components/form";
import { Icon } from "@relay/ui/components/icon";
import { Modal } from "@relay/ui/components/modal";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";
import { api, type Branch } from "@/lib/api";
import { BranchLogo } from "./branch-logo";
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
  /** A new logo was uploaded or removed (saved straight away, the modal stays open). */
  onLogoChanged?: (branch: Branch) => void | Promise<void>;
};

/** Adds a branch, or renames one and changes its timezone. */
export function BranchFormModal({
  open,
  onOpenChange,
  branch,
  onSaved,
  onLogoChanged,
}: BranchFormModalProps) {
  const editing = Boolean(branch);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={editing ? "Edit branch" : "Add a branch"}
      description={
        editing
          ? "Change the logo, the name or the timezone. Opening hours and reports use this timezone."
          : "A branch is one shop or location. Each has its own chats, team and hours."
      }
    >
      {/* The Modal body only mounts while open, so the form starts fresh each time. */}
      {branch ? <LogoPicker branch={branch} onChanged={onLogoChanged} /> : null}
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

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/** Upload, replace or remove the branch's logo. Saved as soon as a file is picked. */
function LogoPicker({
  branch,
  onChanged,
}: {
  branch: Branch;
  onChanged?: (branch: Branch) => void | Promise<void>;
}) {
  const [logoUrl, setLogoUrl] = useState(branch.logoUrl);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const done = async (saved: Branch, message: string) => {
    setLogoUrl(saved.logoUrl);
    notify.success(message);
    await onChanged?.(saved);
  };

  const upload = async (file: File) => {
    if (file.size > MAX_LOGO_BYTES) {
      notify.error("That image is too big", { description: "Logos can be up to 5 MB." });
      return;
    }
    setBusy("upload");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api<{ branch: Branch }>(`/branches/${branch.id}/logo`, {
        method: "POST",
        body: form,
      });
      await done(res.branch, "Logo saved");
    } catch (err) {
      notify.error("Logo not saved", { description: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      const res = await api<{ branch: Branch }>(`/branches/${branch.id}/logo`, { method: "DELETE" });
      await done(res.branch, "Logo removed");
    } catch (err) {
      notify.error("Logo not removed", { description: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-5 flex items-center gap-4">
      <BranchLogo branch={{ name: branch.name, logoUrl }} size="lg" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm font-medium">Logo</span>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => input.current?.click()}
          >
            <Icon name="upload" size="sm" />
            {busy === "upload" ? "Uploading…" : logoUrl ? "Change" : "Upload logo"}
          </Button>
          {logoUrl ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={remove}>
              {busy === "remove" ? "Removing…" : "Remove"}
            </Button>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          JPEG, PNG, WebP or GIF, up to 5 MB. A square image looks best.
        </span>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
    </div>
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
