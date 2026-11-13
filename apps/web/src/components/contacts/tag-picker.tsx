"use client";

import { optionColours } from "@relay/core/contacts";
import { Icon } from "@relay/ui/components/icon";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Checkbox } from "@relay/ui/ui/checkbox";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { Chip } from "./cells";
import { type Tag, useContactActions } from "./queries";

/**
 * Tick tags on or off, search them, and create a new one by typing a name that doesn't exist yet.
 * New tags are for the whole business; branch and channel scoped tags are made in Settings.
 */
export function TagPicker({
  tags,
  value,
  onChange,
  canCreate = true,
}: {
  tags: Tag[];
  value: string[];
  onChange: (ids: string[]) => void;
  canCreate?: boolean;
}) {
  const actions = useContactActions();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = tags.filter((t) => !needle || t.name.toLowerCase().includes(needle));
  const exact = tags.some((t) => t.name.toLowerCase() === needle);

  const create = () => {
    const name = q.trim();
    if (!name || exact) return;
    actions.addTag.mutate(
      { name, colour: optionColours[tags.length % optionColours.length] },
      {
        onSuccess: ({ tag }) => {
          onChange([...value, tag.id]);
          setQ("");
        },
        onError: (err) =>
          notify.error("Couldn't create the tag", {
            description: err instanceof ApiError ? err.message : undefined,
          }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <TextInput
        size="sm"
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (canCreate && needle && !exact) create();
          }
        }}
        placeholder={canCreate ? "Find or create a tag" : "Find a tag"}
        aria-label="Find a tag"
      />
      <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {shown.map((t) => {
          const on = value.includes(t.id);
          return (
            <label key={t.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted">
              <Checkbox
                checked={on}
                onCheckedChange={(v) => onChange(v ? [...value, t.id] : value.filter((x) => x !== t.id))}
              />
              <Chip colour={t.colour}>{t.name}</Chip>
            </label>
          );
        })}
        {!shown.length && !needle ? (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">No tags yet. Type a name to create one.</p>
        ) : null}
      </div>
      {canCreate && needle && !exact ? (
        <button
          type="button"
          onClick={create}
          disabled={actions.addTag.isPending}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm text-primary outline-none hover:bg-muted focus-visible:bg-muted"
        >
          <Icon name="add" size="xs" />
          Create “{q.trim()}”
        </button>
      ) : null}
    </div>
  );
}
