"use client";

import { SwitchRow } from "@relay/ui/components/choice";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Panel, Section } from "@relay/ui/components/section";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Progress } from "@relay/ui/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@relay/ui/ui/toggle-group";
import Link from "next/link";
import { useBranch } from "@/components/shell/branch-context";
import { useMe } from "@/lib/me";
import { cn } from "@/lib/utils";
import { errorText } from "./agents-page";
import { type Agent, type AgentsOverview, useAgentActions } from "./queries";

/** Go live: the on/off switch, which chats the agent takes, its hours, and this month's credits. */

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function GoLiveView({ agent, overview }: { agent: Agent; overview: AgentsOverview }) {
  const { update, setStatus } = useAgentActions();
  const branchId = useBranch().branch.id;
  const timezone = useMe().me?.branches.find((b) => b.id === branchId)?.timezone || "UTC";
  const canManage = overview.canManage;
  const live = agent.status === "live";
  const checks = [
    {
      done: !!(agent.instructions.trim() || agent.role.trim()),
      label: "Its job is written",
      href: "/agents?view=teach",
    },
    {
      done: overview.knowledge.ready > 0,
      label: overview.knowledge.ready
        ? `It knows ${overview.knowledge.ready} thing${overview.knowledge.ready === 1 ? "" : "s"}`
        : "It has some knowledge",
      href: "/agents?view=questions-and-answers",
    },
    { done: !!agent.triedAt, label: "You tried it out", href: "/agents?view=try" },
    { done: overview.aiReady, label: "AI is switched on for this server", href: null },
  ];
  const ready = checks[0]?.done && overview.aiReady;

  const save = (patch: Parameters<typeof update.mutate>[0], ok: string) =>
    update.mutate(patch, {
      onSuccess: () => notify.success(ok),
      onError: (err) => notify.error("Not saved", { description: errorText(err) }),
    });

  const hours = agent.hours ?? { timezone, days: [1, 2, 3, 4, 5, 6], from: "09:00", to: "18:00" };
  const { credits } = overview;
  const usedPct = credits.allowance ? Math.min(100, Math.round((credits.used / credits.allowance) * 100)) : 0;

  return (
    <div className="flex flex-col gap-8">
      <Panel className={cn("flex flex-wrap items-center gap-4", live && "border-good bg-good-soft")}>
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-full",
            live ? "bg-good text-background" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon name={live ? "play" : "pause"} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">
            {live ? `${agent.name} is live` : `${agent.name} isn't answering customers`}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {live
              ? agent.answerUnclaimed
                ? "It answers chats no automation picked up, and chats your automations hand to it."
                : "It answers chats your automations hand to it."
              : "Put it live when you're happy with how it answers in Try."}
          </span>
        </div>
        {canManage ? (
          <Button
            variant={live ? "outline" : "default"}
            disabled={setStatus.isPending || (!live && !ready)}
            onClick={() =>
              setStatus.mutate(
                { id: agent.id, status: live ? "paused" : "live" },
                {
                  onSuccess: () => notify.success(live ? `${agent.name} is paused` : `${agent.name} is live`),
                  onError: (err) =>
                    notify.error(live ? "Not paused" : "Not live", { description: errorText(err) }),
                },
              )
            }
          >
            {live ? "Pause" : "Go live"}
          </Button>
        ) : null}
      </Panel>

      <Section title="Before going live">
        <Panel padding="none">
          <ul className="divide-y">
            {checks.map((c) => (
              <li key={c.label} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Icon
                  name={c.done ? "success" : "pending"}
                  size="sm"
                  className={c.done ? "text-good" : "text-muted-foreground"}
                />
                <span className={cn("flex-1", !c.done && "text-muted-foreground")}>{c.label}</span>
                {!c.done && c.href ? (
                  <Link href={c.href} className="text-[13px] font-medium text-primary hover:underline">
                    Do it
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      </Section>

      <Section title="Which chats it answers">
        <Panel className="flex flex-col divide-y py-1">
          <SwitchRow
            label="Answer chats nobody picked up"
            description="A new message that no automation starts on, in a chat nobody is assigned to. It won't take back a chat it handed over or your team stepped into that day."
            checked={agent.answerUnclaimed}
            disabled={!canManage || update.isPending}
            onCheckedChange={(v) =>
              save(
                { id: agent.id, answerUnclaimed: v },
                v ? "It will answer unclaimed chats" : "It won't answer unclaimed chats",
              )
            }
          />
          <div className="py-2.5 text-[13px] text-muted-foreground">
            Automations can also hand a chat to {agent.name} with the{" "}
            <span className="font-medium text-foreground">Hand to AI agent</span> step.{" "}
            <Link href="/automations" className="font-medium text-primary hover:underline">
              Open automations
            </Link>
          </div>
        </Panel>
      </Section>

      <Section
        title="Hours"
        description="For chats nobody picked up. Chats an automation hands over are answered any time."
      >
        <Panel className="flex flex-col gap-4">
          <SwitchRow
            label="Only during working hours"
            checked={!!agent.hours}
            disabled={!canManage || update.isPending}
            onCheckedChange={(v) =>
              save({ id: agent.id, hours: v ? hours : null }, v ? "Working hours on" : "Answers any time")
            }
          />
          {agent.hours ? (
            <div className="flex flex-col gap-4">
              <ToggleGroup
                type="multiple"
                variant="outline"
                aria-label="Days"
                value={agent.hours.days.map(String)}
                disabled={!canManage}
                onValueChange={(v) =>
                  v.length &&
                  save({ id: agent.id, hours: { ...hours, days: v.map(Number).sort() } }, "Days saved")
                }
                className="flex-wrap justify-start"
              >
                {days.map((d, i) => (
                  <ToggleGroupItem key={d} value={String(i)} className="px-3">
                    {d}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="From">
                  <TextInput
                    type="time"
                    defaultValue={hours.from}
                    disabled={!canManage}
                    onBlur={(e) =>
                      e.target.value &&
                      e.target.value !== hours.from &&
                      save({ id: agent.id, hours: { ...hours, from: e.target.value } }, "Hours saved")
                    }
                  />
                </Field>
                <Field label="To">
                  <TextInput
                    type="time"
                    defaultValue={hours.to}
                    disabled={!canManage}
                    onBlur={(e) =>
                      e.target.value &&
                      e.target.value !== hours.to &&
                      save({ id: agent.id, hours: { ...hours, to: e.target.value } }, "Hours saved")
                    }
                  />
                </Field>
                <span className="pb-2 text-[13px] text-muted-foreground">{hours.timezone}</span>
              </div>
            </div>
          ) : null}
        </Panel>
      </Section>

      <Section
        title="AI credits this month"
        description="One credit per customer message your agent answers. Tests in Try are free."
      >
        <Panel className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between text-sm">
            <span>
              <span className="text-lg font-semibold">{credits.used.toLocaleString()}</span>{" "}
              <span className="text-muted-foreground">of {credits.allowance.toLocaleString()} used</span>
            </span>
            <span className="text-[13px] text-muted-foreground">{credits.left.toLocaleString()} left</span>
          </div>
          <Progress value={usedPct} aria-label="Credits used" />
          {credits.left === 0 ? (
            <p className="text-[13px] text-warning">
              Credits are used up: chats go to your team until next month.
            </p>
          ) : null}
        </Panel>
      </Section>
    </div>
  );
}
