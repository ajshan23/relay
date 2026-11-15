"use client";

import { type NodeCategory, type NodeType, nodeSpecs } from "@relay/core/automations";
import { Icon } from "@relay/ui/components/icon";
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

const groups: { category: NodeCategory; label: string }[] = [
  { category: "message", label: "Messages" },
  { category: "logic", label: "Logic" },
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
  onPick: (type: NodeType) => void;
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
              {specs
                .filter((s) => s.category === g.category)
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
