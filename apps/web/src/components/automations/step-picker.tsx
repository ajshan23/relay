"use client";

import { type NodeCategory, type NodeType, nodeSpecs, type UtilityFn } from "@relay/core/automations";
import { Icon, type IconName } from "@relay/ui/components/icon";
import { Modal } from "@relay/ui/components/modal";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@relay/ui/ui/command";
import { stepIcons } from "./canvas";
import { utilityEntries } from "./utility-form";

const groups: { category: NodeCategory; label: string }[] = [
  { category: "message", label: "Messages" },
  { category: "logic", label: "Logic" },
  { category: "utility", label: "Utilities" },
  { category: "contact", label: "Contact" },
  { category: "chat", label: "Chat" },
];

/** Choose the step to add on an exit. */
export function StepPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** A Utility step comes with its function. */
  onPick: (type: NodeType, utility?: UtilityFn) => void;
}) {
  const specs = Object.values(nodeSpecs);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add a step" size="md">
      <Command className="px-2 pb-3">
        <CommandInput placeholder="Search steps" autoFocus />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>No step matches.</CommandEmpty>
          {groups.map((g) => (
            <CommandGroup key={g.category} heading={g.label}>
              {g.category === "utility"
                ? utilityEntries.map((u) => (
                    <CommandItem
                      key={u.fn}
                      value={`${u.label} ${u.description} ${u.group}`}
                      onSelect={() => onPick("utility", u.fn)}
                      className="flex items-start gap-3 py-2"
                    >
                      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                        <Icon name={u.icon as IconName} size="sm" />
                      </span>
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{u.label}</span>
                        <span className="text-xs text-muted-foreground">{u.description}</span>
                      </span>
                    </CommandItem>
                  ))
                : null}
              {specs
                .filter((s) => s.category === g.category && s.type !== "utility")
                .map((s) => (
                  <CommandItem
                    key={s.type}
                    value={`${s.label} ${s.description}`}
                    onSelect={() => onPick(s.type as NodeType)}
                    className="flex items-start gap-3 py-2"
                  >
                    <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Icon name={stepIcons[s.type] ?? "automation"} size="sm" />
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{s.label}</span>
                      <span className="text-xs text-muted-foreground">{s.description}</span>
                    </span>
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </Modal>
  );
}
