"use client";

import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { AgentAvatar } from "@relay/ui/components/person";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { cn } from "@relay/ui/lib/utils";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { RadioGroup, RadioGroupItem } from "@relay/ui/ui/radio-group";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useBranch } from "@/components/shell/branch-context";
import { errorText, statusWords } from "./agents-page";
import { type Agent, useAgentActions } from "./queries";

/*
 * A branch can have several AI agents (say, support on one number and sales on others; automations'
 * "Hand to AI agent" step picks which). The page works on one at a time: ?agent=, else the last one
 * picked in this browser for this branch, else the first.
 */

const storeKey = (branchId: string) => `relay.agent.${branchId}`;

function remembered(branchId: string): string | null {
  try {
    return localStorage.getItem(storeKey(branchId));
  } catch {
    return null;
  }
}

function remember(branchId: string, agentId: string) {
  try {
    localStorage.setItem(storeKey(branchId), agentId);
  } catch {
    // Private window or blocked storage: the ?agent= in the address still works.
  }
}

/** The agent the page shows, and a way to switch to another one. */
export function useSelectedAgent(agents: Agent[] | undefined) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const branchId = useBranch().branch.id;
  const [stored, setStored] = useState<string | null>(null);
  useEffect(() => setStored(remembered(branchId)), [branchId]);

  const wanted = params.get("agent") ?? stored;
  const agent = agents?.find((a) => a.id === wanted) ?? agents?.[0];

  const select = (id: string) => {
    remember(branchId, id);
    setStored(id);
    const next = new URLSearchParams(params.toString());
    next.set("agent", id);
    router.replace(`${pathname}?${next}`);
  };
  return { agent, select };
}

/** The agent's name in the page header, opening a menu of the branch's agents and "New agent". */
export function AgentSwitcher({
  agents,
  agent,
  onSelect,
  canManage,
  starters,
}: {
  agents: Agent[];
  agent: Agent;
  onSelect: (id: string) => void;
  canManage: boolean;
  starters: Starter[];
}) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`AI agent: ${agent.name}. Switch agent`}
            className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <h1 className="truncate text-2xl font-semibold tracking-tight">{agent.name}</h1>
            <Icon name="chevronsUpDown" size="sm" className="shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            AI agents in this branch
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={agent.id} onValueChange={onSelect}>
            {agents.map((a) => (
              <DropdownMenuRadioItem key={a.id} value={a.id} className="gap-2">
                <AgentAvatar name={a.name} size="sm" decorative />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate">{a.name}</span>
                  {a.role ? <span className="truncate text-xs text-muted-foreground">{a.role}</span> : null}
                </span>
                <Tag size="sm" tone={statusWords[a.status].tone}>
                  {statusWords[a.status].label}
                </Tag>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {canManage ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreating(true)}>
                <Icon name="add" size="sm" />
                New agent
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewAgentModal
        open={creating}
        onOpenChange={setCreating}
        starters={starters}
        onCreated={(id) => onSelect(id)}
      />
    </>
  );
}

type Starter = { id: string; label: string; instructions: string };

const BLANK = "__blank__";

/** Name the new agent and pick what it starts from; it starts not live, like the first one. */
export function NewAgentModal({
  open,
  onOpenChange,
  starters,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  starters: Starter[];
  onCreated: (id: string) => void;
}) {
  const { create } = useAgentActions();
  const [name, setName] = useState("");
  const [starter, setStarter] = useState<string>(BLANK);
  useEffect(() => {
    if (open) {
      setName("");
      setStarter(starters[0]?.id ?? BLANK);
    }
  }, [open, starters]);

  const submit = () =>
    create.mutate(
      { name: name.trim() || undefined, starter: starter === BLANK ? undefined : starter },
      {
        onSuccess: ({ agent }) => {
          notify.success(`${agent.name} is ready to learn`, {
            description: "Teach it its job, try it, then put it live.",
          });
          onOpenChange(false);
          onCreated(agent.id);
        },
        onError: (err) => notify.error("Couldn't add the agent", { description: errorText(err) }),
      },
    );

  const options = [...starters, { id: BLANK, label: "Blank", instructions: "Start from an empty page." }];
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New AI agent"
      description="For a different job, such as support on one number and sales on others. Automations' Hand to AI agent step picks which agent takes a chat."
      size="lg"
      footer={
        <ModalActions>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={create.isPending} onClick={submit}>
            {create.isPending ? "Adding…" : "Add agent"}
          </Button>
        </ModalActions>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" hint="What customers see, e.g. Mira, Sam or Leila.">
          <TextInput
            value={name}
            maxLength={40}
            placeholder="Mira"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <span id="new-agent-start" className="text-sm font-medium">
            Start from
          </span>
          <RadioGroup
            aria-labelledby="new-agent-start"
            value={starter}
            onValueChange={setStarter}
            className="grid gap-2 sm:grid-cols-2"
          >
            {options.map((s) => (
              <label
                key={s.id}
                htmlFor={`starter-${s.id}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:border-primary",
                  starter === s.id && "border-primary bg-accent",
                )}
              >
                <RadioGroupItem id={`starter-${s.id}`} value={s.id} className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium">{s.label}</span>
                  <span className="line-clamp-2 text-[13px] text-muted-foreground">
                    {s.instructions.split("\n")[0]}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>
      </form>
    </Modal>
  );
}
