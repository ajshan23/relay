"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { ApiError } from "@/lib/api";
import { useGoogleActions, useGoogleCalendar } from "./queries";

/*
 * Where free times come from: Relay's booking book, plus the branch's Google Calendar when connected.
 * Bookings go into the calendar (online services with a Meet link); its busy times block bookings.
 */

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Try again.";

/** What Google's consent screen sent the manager back with. */
const outcomes: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Calendar connected" },
  cancelled: { ok: false, text: "Google Calendar wasn't connected: you cancelled on Google's screen." },
  expired: { ok: false, text: "That connection attempt expired. Try again." },
  forbidden: { ok: false, text: "Only managers of this branch can connect a calendar." },
  no_offline_access: {
    ok: false,
    text: "Google didn't give lasting access. Remove Relay in your Google account's third-party access, then connect again.",
  },
  no_calendars: { ok: false, text: "That Google account has no calendar of its own to add bookings to." },
  not_configured: { ok: false, text: "Google isn't set up on this server yet." },
  failed: { ok: false, text: "Google Calendar couldn't be connected. Try again." },
};

export function GoogleCalendarBlock() {
  const q = useGoogleCalendar();
  const { connect, choose, reload, disconnect } = useGoogleActions();
  const [confirm, confirmDialog] = useConfirm();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Coming back from Google: say how it went, then tidy the address.
  const outcome = params.get("google");
  useEffect(() => {
    if (!outcome) return;
    const o = outcomes[outcome];
    if (o) (o.ok ? notify.success : notify.error)(o.text);
    const next = new URLSearchParams(params.toString());
    next.delete("google");
    router.replace(`${pathname}?${next}`);
  }, [outcome, params, pathname, router]);

  if (q.isPending) return <Skeleton className="h-24 w-full" />;
  if (q.isError) return <p className="text-[13px] text-destructive">{errorText(q.error)}</p>;
  const { configured, connection: conn, canManage } = q.data;

  const relayLine = (
    <p className="text-[13px] text-muted-foreground">
      Relay's booking book always decides what's free. Calendly and Cal.com come later.
    </p>
  );

  if (!conn)
    return (
      <Panel className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <Icon name="calendar" className="mt-0.5 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">Google Calendar</span>
            <span className="text-[13px] text-muted-foreground">
              Bookings appear in your calendar, your own events there block those times, and online services
              get a Google Meet link.
            </span>
          </div>
          {canManage ? (
            <Button
              disabled={!configured || connect.isPending}
              onClick={() =>
                connect.mutate(undefined, {
                  onError: (err) => notify.error("Couldn't start", { description: errorText(err) }),
                })
              }
            >
              {connect.isPending ? "Opening Google…" : "Connect Google Calendar"}
            </Button>
          ) : null}
        </div>
        {!configured ? (
          <p className="text-[13px] text-muted-foreground">Google isn't set up on this server yet.</p>
        ) : null}
        {relayLine}
      </Panel>
    );

  return (
    <Panel className="flex flex-col gap-4">
      {confirmDialog}
      <div className="flex flex-wrap items-start gap-3">
        <Icon name="calendar" className="mt-0.5 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Google Calendar</span>
            {conn.status === "active" ? (
              <Tag size="sm" tone="good">
                Connected
              </Tag>
            ) : conn.status === "needs_reconnect" ? (
              <Tag size="sm" tone="danger">
                Needs connecting again
              </Tag>
            ) : (
              <Tag size="sm" tone="warning">
                Pick a calendar
              </Tag>
            )}
          </div>
          <span className="text-[13px] text-muted-foreground">{conn.accountEmail ?? "Google account"}</span>
        </div>
        {canManage ? (
          <Button
            variant="ghost"
            onClick={async () => {
              if (
                await confirm({
                  title: "Disconnect Google Calendar?",
                  description:
                    "New bookings stop going into Google and its busy times stop blocking bookings. Events already added stay in your calendar.",
                  confirmLabel: "Disconnect",
                  tone: "danger",
                })
              )
                disconnect.mutate(undefined, {
                  onSuccess: () => notify.success("Google Calendar disconnected"),
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
            {conn.lastError ?? "Google stopped letting Relay use this calendar."} Bookings still work in Relay
            meanwhile.
          </span>
          {canManage ? (
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
              Reconnect Google
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Calendar for bookings"
          className="min-w-56 flex-1"
          hint="Only calendars you own can take bookings."
        >
          <SelectField
            options={conn.calendars.map((c) => ({
              value: c.id,
              label: c.primary ? `${c.name} (main)` : c.name,
            }))}
            value={conn.calendarId ?? undefined}
            placeholder="Pick a calendar"
            disabled={!canManage || choose.isPending}
            onValueChange={(id) =>
              choose.mutate(id, {
                onSuccess: () =>
                  notify.success("Calendar changed", { description: "Upcoming bookings are added to it." }),
                onError: (err) => notify.error("Not changed", { description: errorText(err) }),
              })
            }
          />
        </Field>
        {canManage ? (
          <Button
            variant="outline"
            disabled={reload.isPending || conn.status === "needs_reconnect"}
            onClick={() =>
              reload.mutate(undefined, {
                onError: (err) =>
                  notify.error("Couldn't read your calendars", { description: errorText(err) }),
              })
            }
          >
            <Icon name="refresh" size="sm" /> Read calendars again
          </Button>
        ) : null}
      </div>
      <p className="text-[13px] text-muted-foreground">
        Bookings are added to this calendar as free time, so they don't block each other. Your own busy events
        block those times for customers. No invitations are emailed; Meet links go out on WhatsApp.
      </p>
      {relayLine}
    </Panel>
  );
}
