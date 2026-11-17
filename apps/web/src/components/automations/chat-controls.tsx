"use client";

import { Icon } from "@relay/ui/components/icon";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { useChatAutomation, useChatAutomationActions } from "./queries";

/*
 * Automations in the inbox: a bar over the chat while one is in charge of it (with Stop), and a
 * "Run automation" button for the ones a team member starts from a chat (e.g. a feedback ask).
 * A reply from the team also stops the running one (if its rules say so).
 */

export function AutomationBanner({ conversationId }: { conversationId: string }) {
  const q = useChatAutomation(conversationId);
  const { stop } = useChatAutomationActions(conversationId);
  const current = q.data?.current;
  if (!current) return null;
  if (current.kind === "ai") {
    return (
      <div
        className="flex items-center gap-2 border-b bg-accent px-4 py-2 text-[13px] text-accent-foreground"
        role="status"
      >
        <Icon name="sparkles" size="sm" />
        <span className="min-w-0 flex-1 truncate">
          <Link href="/agents" className="font-medium hover:underline">
            {current.name}
          </Link>{" "}
          (AI agent) is handling this chat. Replying yourself takes it over.
        </span>
        {q.data?.canRun ? (
          <Button
            size="xs"
            variant="outline"
            disabled={stop.isPending}
            onClick={() =>
              stop.mutate(undefined, {
                onSuccess: () => notify.success(`You've taken over from ${current.name}`),
                onError: (err) =>
                  notify.error("Not taken over", {
                    description: err instanceof ApiError ? err.message : undefined,
                  }),
              })
            }
          >
            Take over
          </Button>
        ) : null}
      </div>
    );
  }
  const doing =
    current.status === "waiting"
      ? "waiting for their reply"
      : current.status === "sleeping"
        ? "waiting (a Wait step)"
        : "running";
  return (
    <div
      className="flex items-center gap-2 border-b bg-accent px-4 py-2 text-[13px] text-accent-foreground"
      role="status"
    >
      <Icon name="automation" size="sm" />
      <span className="min-w-0 flex-1 truncate">
        <Link
          href={`/automations/${current.automationId ?? ""}?tab=runs`}
          className="font-medium hover:underline"
        >
          {current.name}
        </Link>
        {current.test ? " (test)" : ""} is {doing} in this chat.
      </span>
      {q.data?.canRun ? (
        <Button
          size="xs"
          variant="outline"
          disabled={stop.isPending}
          onClick={() =>
            stop.mutate(undefined, {
              onSuccess: () => notify.success("Automation stopped"),
              onError: (err) =>
                notify.error("Not stopped", {
                  description: err instanceof ApiError ? err.message : undefined,
                }),
            })
          }
        >
          Stop
        </Button>
      ) : null}
    </div>
  );
}

export function RunAutomationButton({ conversationId }: { conversationId: string }) {
  const q = useChatAutomation(conversationId);
  const { run } = useChatAutomationActions(conversationId);
  const runnable = q.data?.runnable ?? [];
  if (!q.data?.canRun || !runnable.length || q.data.current) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Run an automation" title="Run an automation">
          <Icon name="automation" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Run an automation
        </DropdownMenuLabel>
        {runnable.map((a) => (
          <DropdownMenuItem
            key={a.id}
            disabled={run.isPending}
            className="flex flex-col items-start"
            onSelect={() =>
              run.mutate(a.id, {
                onSuccess: () => notify.success(`${a.name} started`),
                onError: (err) =>
                  notify.error("Not started", {
                    description: err instanceof ApiError ? err.message : undefined,
                  }),
              })
            }
          >
            <span className="text-sm">{a.name}</span>
            {a.description ? <span className="text-xs text-muted-foreground">{a.description}</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
