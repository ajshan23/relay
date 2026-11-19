"use client";

import type { BookingRange, BookingSettings } from "@relay/core/bookings";
import { SwitchRow } from "@relay/ui/components/choice";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Panel, Section } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Switch } from "@relay/ui/ui/switch";
import Link from "next/link";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { GoogleCalendarBlock } from "./google-calendar";
import { type BookingSettingsData, useBookingActions, useBookingSettings } from "./queries";

/*
 * Booking settings: whether customers can book on WhatsApp, opening hours (any number of ranges a
 * day), closed dates, how bookings are spaced, how soon and how far ahead, and the reminders sent.
 */

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Try again.";
const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const stepOptions = [10, 15, 20, 30, 45, 60, 90, 120].map((m) => ({
  value: String(m),
  label: `Every ${m} minutes`,
}));
const bufferOptions = [0, 5, 10, 15, 30, 60].map((m) => ({
  value: String(m),
  label: m ? `${m} minutes` : "No gap",
}));
const noticeOptions = [
  [0, "Any time"],
  [30, "30 minutes before"],
  [60, "1 hour before"],
  [120, "2 hours before"],
  [240, "4 hours before"],
  [1440, "1 day before"],
  [2880, "2 days before"],
].map(([m, label]) => ({ value: String(m), label: String(label) }));

const reminderLabel = (h: number) =>
  h >= 24 && h % 24 === 0
    ? `${h / 24} day${h === 24 ? "" : "s"} before`
    : `${h} hour${h === 1 ? "" : "s"} before`;

export function BookingSettingsView() {
  const q = useBookingSettings();
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError)
    return (
      <EmptyState
        icon={<Icon name="alert" />}
        title="Couldn't load booking settings"
        description={errorText(q.error)}
      />
    );
  return <SettingsForm data={q.data} key={JSON.stringify(q.data.settings)} />;
}

function SettingsForm({ data }: { data: BookingSettingsData }) {
  const { saveSettings } = useBookingActions();
  const [s, setS] = useState<BookingSettings>(data.settings);
  const [closedDay, setClosedDay] = useState("");
  const [customHours, setCustomHours] = useState("");
  const can = data.canManage;
  const set = (patch: Partial<BookingSettings>) => setS({ ...s, ...patch });
  const rangesOf = (day: number) => s.hours.filter((r) => r.day === day);
  const setRanges = (day: number, ranges: BookingRange[]) =>
    set({
      hours: [...s.hours.filter((r) => r.day !== day), ...ranges].sort(
        (a, b) => a.day - b.day || a.from.localeCompare(b.from),
      ),
    });
  const changed = JSON.stringify(s) !== JSON.stringify(data.settings);
  const chosenTemplate = data.templates.find((t) => t.id === s.reminderTemplateId);

  return (
    <div className="flex flex-col gap-8">
      <Panel>
        <SwitchRow
          label="Take bookings"
          description={`Customers can book on WhatsApp with Mira, and your team in Bookings. ${data.services.length} service${data.services.length === 1 ? "" : "s"} can be booked.`}
          checked={s.enabled}
          disabled={!can}
          onCheckedChange={(enabled) => set({ enabled })}
        />
        {!data.services.length ? (
          <p className="mt-1 text-[13px] text-muted-foreground">
            No service can be booked yet: open a service in the{" "}
            <Link href="/agents?view=items" className="font-medium text-primary hover:underline">
              catalogue
            </Link>
            , give it a length and turn on Can be booked.
          </p>
        ) : null}
      </Panel>

      <Section title="Opening hours" description={`When bookings can start and end, in ${data.timezone}.`}>
        <Panel padding="none">
          <ul className="divide-y">
            {dayNames.map((name, i) => {
              const day = i + 1;
              const ranges = rangesOf(day);
              return (
                <li key={name} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="flex w-36 items-center gap-2 pt-1.5">
                    <Switch
                      aria-label={`Open on ${name}`}
                      checked={ranges.length > 0}
                      disabled={!can}
                      onCheckedChange={(open) =>
                        setRanges(day, open ? [{ day, from: "09:00", to: "18:00" }] : [])
                      }
                    />
                    <span className="text-sm font-medium">{name}</span>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {ranges.length ? (
                      ranges.map((r, n) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: ranges of one day, edited in place
                        <div key={n} className="flex items-center gap-2">
                          <TextInput
                            type="time"
                            aria-label={`${name} opens`}
                            className="w-32"
                            value={r.from}
                            disabled={!can}
                            onChange={(e) =>
                              setRanges(
                                day,
                                ranges.map((x, j) => (j === n ? { ...x, from: e.target.value } : x)),
                              )
                            }
                          />
                          <span className="text-[13px] text-muted-foreground">to</span>
                          <TextInput
                            type="time"
                            aria-label={`${name} closes`}
                            className="w-32"
                            value={r.to}
                            disabled={!can}
                            onChange={(e) =>
                              setRanges(
                                day,
                                ranges.map((x, j) => (j === n ? { ...x, to: e.target.value } : x)),
                              )
                            }
                          />
                          {can ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Remove these hours"
                              onClick={() =>
                                setRanges(
                                  day,
                                  ranges.filter((_, j) => j !== n),
                                )
                              }
                            >
                              <Icon name="close" size="sm" />
                            </Button>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <span className="pt-1.5 text-[13px] text-muted-foreground">Closed</span>
                    )}
                    {can && ranges.length ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="self-start"
                        onClick={() => setRanges(day, [...ranges, { day, from: "17:00", to: "21:00" }])}
                      >
                        <Icon name="add" size="sm" /> Add hours
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      </Section>

      <Section title="Closed dates" description="Holidays and other days nobody can book.">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Day" className="w-44">
            <TextInput
              type="date"
              value={closedDay}
              disabled={!can}
              onChange={(e) => setClosedDay(e.target.value)}
            />
          </Field>
          <Button
            variant="outline"
            disabled={!can || !closedDay || s.closedDates.includes(closedDay)}
            onClick={() => {
              set({ closedDates: [...s.closedDates, closedDay].sort() });
              setClosedDay("");
            }}
          >
            Add
          </Button>
        </div>
        {s.closedDates.length ? (
          <div className="flex flex-wrap gap-1.5">
            {s.closedDates.map((d) => (
              <span
                key={d}
                className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-[13px] tabular-nums"
              >
                {d}
                {can ? (
                  <button
                    type="button"
                    aria-label={`Open on ${d} again`}
                    className="rounded text-muted-foreground hover:text-foreground"
                    onClick={() => set({ closedDates: s.closedDates.filter((x) => x !== d) })}
                  >
                    <Icon name="close" size="sm" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </Section>

      <Section title="How bookings work">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start times" hint="How often a booking can start">
            <SelectField
              options={stepOptions}
              value={String(s.stepMinutes)}
              disabled={!can}
              onValueChange={(v) => set({ stepMinutes: Number(v) })}
            />
          </Field>
          <Field label="Gap after each booking" hint="Kept free to clean up or get ready">
            <SelectField
              options={bufferOptions}
              value={String(s.bufferMinutes)}
              disabled={!can}
              onValueChange={(v) => set({ bufferMinutes: Number(v) })}
            />
          </Field>
          <Field label="Book at least" hint="How soon before the time">
            <SelectField
              options={noticeOptions}
              value={String(s.minNoticeMinutes)}
              disabled={!can}
              onValueChange={(v) => set({ minNoticeMinutes: Number(v) })}
            />
          </Field>
          <Field label="Book up to (days ahead)">
            <TextInput
              inputMode="numeric"
              value={String(s.maxDaysAhead)}
              disabled={!can}
              onChange={(e) =>
                set({
                  maxDaysAhead: Math.min(365, Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1)),
                })
              }
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Reminders"
        description="Sent on WhatsApp with Confirm and Change buttons. Confirm marks the booking confirmed; Change goes to Mira or your team."
      >
        <Panel padding="none">
          <ul className="divide-y">
            {s.reminders.map((r, i) => (
              <li key={`${r.hoursBefore}`} className="flex items-center gap-3 px-4">
                <SwitchRow
                  className="flex-1"
                  label={reminderLabel(r.hoursBefore)}
                  checked={r.enabled}
                  disabled={!can}
                  onCheckedChange={(enabled) =>
                    set({ reminders: s.reminders.map((x, j) => (j === i ? { ...x, enabled } : x)) })
                  }
                />
                {can ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove the reminder ${reminderLabel(r.hoursBefore)}`}
                    onClick={() => set({ reminders: s.reminders.filter((_, j) => j !== i) })}
                  >
                    <Icon name="delete" size="sm" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
        {can && s.reminders.length < 5 ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Hours before" className="w-36">
              <TextInput
                inputMode="numeric"
                placeholder="48"
                value={customHours}
                onChange={(e) => setCustomHours(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Button
              variant="outline"
              disabled={
                !customHours ||
                Number(customHours) < 1 ||
                Number(customHours) > 168 ||
                s.reminders.some((r) => r.hoursBefore === Number(customHours))
              }
              onClick={() => {
                set({
                  reminders: [...s.reminders, { hoursBefore: Number(customHours), enabled: true }].sort(
                    (a, b) => b.hoursBefore - a.hoursBefore,
                  ),
                });
                setCustomHours("");
              }}
            >
              <Icon name="add" size="sm" /> Add reminder
            </Button>
          </div>
        ) : null}
        <Field
          label="Template for reminders outside the 24-hour window"
          hint={
            <>
              WhatsApp only allows an approved template when the customer hasn't written in 24 hours. Start
              from &ldquo;Booking reminder&rdquo; in{" "}
              <Link href="/settings/templates" className="font-medium text-primary hover:underline">
                Templates
              </Link>
              .
            </>
          }
        >
          <SelectField
            options={[
              { value: "none", label: "None (skip those reminders)" },
              ...data.templates.map((t) => ({
                value: t.id,
                label: t.name,
                description: t.ready ? "Approved" : "Not approved yet",
              })),
            ]}
            value={s.reminderTemplateId ?? "none"}
            disabled={!can}
            onValueChange={(v) => set({ reminderTemplateId: v === "none" ? null : v })}
          />
        </Field>
        <Field
          label="Template for online services (with the Meet link)"
          hint="Optional. Start from “Online booking reminder”. Without one, online bookings use the template above."
        >
          <SelectField
            options={[
              { value: "none", label: "Same as above" },
              ...data.templates.map((t) => ({
                value: t.id,
                label: t.name,
                description: t.ready ? "Approved" : "Not approved yet",
              })),
            ]}
            value={s.onlineReminderTemplateId ?? "none"}
            disabled={!can}
            onValueChange={(v) => set({ onlineReminderTemplateId: v === "none" ? null : v })}
          />
        </Field>
        {chosenTemplate && !chosenTemplate.ready ? (
          <Tag tone="warning" size="sm" className="self-start">
            This template isn't approved yet, so those reminders are skipped for now.
          </Tag>
        ) : null}
      </Section>

      <Section title="Where free times come from">
        <GoogleCalendarBlock />
      </Section>

      {can ? (
        <div className="sticky bottom-4 flex justify-end">
          <Button
            disabled={!changed || saveSettings.isPending}
            onClick={() =>
              saveSettings.mutate(s, {
                onSuccess: () => notify.success("Booking settings saved"),
                onError: (err) => notify.error("Not saved", { description: errorText(err) }),
              })
            }
          >
            {saveSettings.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
