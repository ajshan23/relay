"use client";

import { SwitchRow } from "@relay/ui/components/choice";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { errorText } from "./agents-page";
import { type FollowUpRow, useGoogleTasks, useGoogleTasksActions } from "./queries";

/*
 * Google Tasks: when a person has to do something after a chat (call back, check a question, send a
 * quote), the agent adds it to the branch's Google Tasks, so it shows in Gmail, Calendar and the
 * Tasks app on the team's phones.
 */

/** What Google's consent screen sent the manager back with. */
const outcomes: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Tasks connected" },
  cancelled: { ok: false, text: "Google Tasks wasn't connected: you cancelled on Google's screen." },
  expired: { ok: false, text: "That connection attempt expired. Try again." },
  forbidden: { ok: false, text: "Only people who can change the AI agent can connect Google Tasks." },
  no_offline_access: {
    ok: false,
    text: "Google didn't give lasting access. Remove Relay in your Google account's third-party access, then connect again.",
  },
  no_tasks_permission: {
    ok: false,
    text: "Google Tasks wasn't connected: tick the permission to see and change your tasks on Google's screen.",
  },
  not_configured: { ok: false, text: "Google isn't set up on this server yet." },
  failed: { ok: false, text: "Google Tasks couldn't be connected. Try again." },
};

const NEW_LIST = "__new__";

const dueLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`)
    .toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .replace(",", "");

const statusTag: Record<
  FollowUpRow["status"],
  { label: string; tone: "good" | "danger" | "plain" | "primary" }
> = {
  open: { label: "To do", tone: "primary" },
  done: { label: "Done", tone: "good" },
  failed: { label: "Not added", tone: "danger" },
  sending: { label: "Adding…", tone: "plain" },
};

export function GoogleTasksBlock({ agentName }: { agentName: string }) {
  const q = useGoogleTasks();
  const { connect, update, reload, disconnect } = useGoogleTasksActions();
  const [confirm, confirmDialog] = useConfirm();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Coming back from Google: say how it went, then tidy the address.
  const outcome = params.get("google_tasks");
  useEffect(() => {
    if (!outcome) return;
    const o = outcomes[outcome];
    if (o) (o.ok ? notify.success : notify.error)(o.text);
    const next = new URLSearchParams(params.toString());
    next.delete("google_tasks");
    router.replace(`${pathname}?${next}`);
  }, [outcome, params, pathname, router]);

  if (q.isPending) return <Skeleton className="h-24 w-full" />;
  if (q.isError) return <p className="text-[13px] text-destructive">{errorText(q.error)}</p>;
  const { configured, connection: conn, recent, canManage } = q.data;
  const save = (json: Parameters<typeof update.mutate>[0], done?: string) =>
    update.mutate(json, {
      onSuccess: () => (done ? notify.success(done) : undefined),
      onError: (err) => notify.error("Not saved", { description: errorText(err) }),
    });

  const heading = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Google Tasks</span>
        {conn?.status === "active" ? (
          <Tag size="sm" tone="good">
            Connected
          </Tag>
        ) : conn ? (
          <Tag size="sm" tone="danger">
            Needs connecting again
          </Tag>
        ) : null}
      </div>
      <span className="text-[13px] text-muted-foreground">
        {conn
          ? (conn.accountEmail ?? "Google account")
          : `When someone has to call back, check something or send a quote, ${agentName} adds it to your Google Tasks. It shows in Gmail, Google Calendar and the Tasks app.`}
      </span>
    </div>
  );

  if (!conn)
    return (
      <Panel className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <Icon name="check" className="mt-0.5 text-muted-foreground" />
          {heading}
          {canManage ? (
            <Button
              disabled={!configured || connect.isPending}
              onClick={() =>
                connect.mutate(undefined, {
                  onError: (err) => notify.error("Couldn't start", { description: errorText(err) }),
                })
              }
            >
              {connect.isPending ? "Opening Google…" : "Connect Google Tasks"}
            </Button>
          ) : null}
        </div>
        {!configured ? (
          <p className="text-[13px] text-muted-foreground">Google isn't set up on this server yet.</p>
        ) : null}
      </Panel>
    );

  return (
    <Panel className="flex flex-col gap-4">
      {confirmDialog}
      <div className="flex flex-wrap items-start gap-3">
        <Icon name="check" className="mt-0.5 text-muted-foreground" />
        {heading}
        {canManage ? (
          <Button
            variant="ghost"
            onClick={async () => {
              if (
                await confirm({
                  title: "Disconnect Google Tasks?",
                  description: `${agentName} stops adding follow-ups. Tasks already added stay in Google Tasks.`,
                  confirmLabel: "Disconnect",
                  tone: "danger",
                })
              )
                disconnect.mutate(undefined, {
                  onSuccess: () => notify.success("Google Tasks disconnected"),
                  onError: (err) => notify.error("Not disconnected", { description: errorText(err) }),
                });
            }}
          >
            Disconnect
          </Button>
        ) : null}
      </div>

      {conn.status === "needs_reconnect" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px]">
          <Icon name="warning" size="sm" className="text-destructive" />
          <span className="min-w-0 flex-1">
            {conn.lastError ?? "Google stopped letting Relay add tasks."} Until then, {agentName} only notes
            follow-ups in the chat.
          </span>
          {canManage ? (
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
              Reconnect Google
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Add follow-ups to" className="min-w-56 flex-1">
          <SelectField
            options={[
              ...conn.lists.map((l) => ({ value: l.id, label: l.name })),
              ...(conn.lists.some((l) => l.name === "WhatsApp follow-ups")
                ? []
                : [{ value: NEW_LIST, label: "New list: WhatsApp follow-ups" }]),
            ]}
            value={conn.listId ?? undefined}
            placeholder="Pick a list"
            disabled={!canManage || update.isPending || conn.status !== "active"}
            onValueChange={(id) =>
              save(id === NEW_LIST ? { newList: true } : { listId: id }, "Follow-ups go to this list now")
            }
          />
        </Field>
        {canManage ? (
          <Button
            variant="outline"
            disabled={reload.isPending || conn.status !== "active"}
            onClick={() =>
              reload.mutate(undefined, {
                onError: (err) => notify.error("Couldn't read your lists", { description: errorText(err) }),
              })
            }
          >
            <Icon name="refresh" size="sm" /> Read lists again
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col divide-y">
        <SwitchRow
          label={`${agentName} can add follow-up tasks`}
          description="For callbacks, questions for the team and quotes. The chat gets a note each time."
          checked={conn.enabled}
          disabled={!canManage || update.isPending}
          onCheckedChange={(v) => save({ enabled: v })}
        />
        <SwitchRow
          label={`Also add a task whenever ${agentName} hands a chat to the team`}
          description="Due today, with the reason and a link to the chat. Handy outside working hours."
          checked={conn.onHandoff}
          disabled={!canManage || update.isPending}
          onCheckedChange={(v) => save({ onHandoff: v })}
        />
      </div>

      {recent.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium">Recent follow-ups</span>
          <ul className="flex flex-col divide-y rounded-md border">
            {recent.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                {t.dueDate ? <span className="text-muted-foreground">Due {dueLabel(t.dueDate)}</span> : null}
                {t.source === "handoff" ? <Tag size="sm">Hand-over</Tag> : null}
                <Tag size="sm" tone={statusTag[t.status].tone}>
                  {statusTag[t.status].label}
                </Tag>
                {t.conversationId ? (
                  <Link
                    href={`/conversations?view=all&c=${t.conversationId}`}
                    className="text-primary hover:underline"
                  >
                    Chat
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          No follow-ups yet. Try it: in Try, ask {agentName} to call you back tomorrow.
        </p>
      )}
    </Panel>
  );
}
