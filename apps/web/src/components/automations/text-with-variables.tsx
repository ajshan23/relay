"use client";

import type { AutomationDefinition } from "@relay/core/automations";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Textarea } from "@relay/ui/ui/textarea";
import { useRef } from "react";
import type { EditorOptions } from "./queries";
import { savedGroups, savedValues } from "./saved-values";

/** A text that can hold {{details}}, with a menu to insert them: answers, worked-out values, contact. */
export function TextWithVariables({
  label,
  hint,
  value,
  onChange,
  def,
  options,
  rows = 4,
  max,
  optional,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  def: AutomationDefinition;
  options?: EditorOptions;
  rows?: number;
  max?: number;
  optional?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, at)}${token}${value.slice(el?.selectionEnd ?? at)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  const saved = savedValues(def, options);
  return (
    <Field label={label} hint={hint} optional={optional}>
      {(control) => (
        <div className="flex flex-col gap-1">
          <Textarea
            {...control}
            ref={ref}
            rows={rows}
            value={value}
            maxLength={max}
            onChange={(e) => onChange(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground">
                  <Icon name="add" />
                  Insert detail
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                {savedGroups.map((g, i) => {
                  const items = saved.filter((v) => v.group === g);
                  if (!items.length) return null;
                  return (
                    <div key={g}>
                      {i > 0 ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuLabel>{g}</DropdownMenuLabel>
                      {items.map((v) => (
                        <DropdownMenuItem key={v.path} onSelect={() => insert(`{{${v.path}}}`)}>
                          {v.label}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            {max ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {value.length}/{max}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </Field>
  );
}
