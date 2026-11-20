"use client";

import { type BookingStatus, localTime, zonedTime } from "@relay/core/bookings";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { ModalActions } from "@relay/ui/components/modal";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { SidePanel } from "@relay/ui/components/side-panel";
import { Tag, type Tone } from "@relay/ui/components/tag";
import { TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relay/ui/ui/dropdown-menu";
import { Skeleton } from "@relay/ui/ui/skeleton";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  type Booking,
  useBookingActions,
  useBookingContacts,
  useBookingSettings,
  useBookings,
  useFreeTimes,
  useGoogleCalendar,
} from "./queries";

/*
 * Bookings: the branch's booking book, from a chosen day for two weeks, grouped by day. The team marks
 * arrivals and no-shows, cancels, moves a booking to a free time, invites people by email (Google
 * Calendar sends the invite) and books for a customer by hand.
 */

/** Emails typed in one box, split on commas, spaces or new lines. */
const splitEmails = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Whether this branch's bookings go to a Google Calendar (invites need it). */
function useInvitesWork() {
  const google = useGoogleCalendar();
  return google.data?.connection?.status === "active";
}

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Try again.";

const statusLook: Record<BookingStatus, { label: string; tone: Tone }> = {
  booked: { label: "Booked", tone: "primary" },
  confirmed: { label: "Confirmed", tone: "good" },
  arrived: { label: "Arrived", tone: "good" },
  no_show: { label: "No-show", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "plain" },
};

const DAYS = 14;

export function BookingsView() {
  const settings = useBookingSettings();
  const tz = settings.data?.timezone ?? "UTC";
  const today = localTime(new Date(), tz).date;
  const [day, setDay] = useState("");
  const startDay = day || today;
  const from = useMemo(() => zonedTime(startDay, 0, tz), [startDay, tz]);
  const to = useMemo(() => new Date(from.getTime() + DAYS * 86_400_000), [from]);
  const list = useBookings(from, to);
  const [service, setService] = useState("all");
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<Booking | null>(null);
  const [inviting, setInviting] = useState<Booking | null>(null);

  if (settings.isPending) return <Skeleton className="h-48 w-full" />;
  if (settings.isError)
    return (
      <EmptyState
        icon={<Icon name="alert" />}
        title="Couldn't load bookings"
        description={errorText(settings.error)}
      />
    );
  const { services } = settings.data;
  const enabled = settings.data.settings.enabled;
  const rows = (list.data?.bookings ?? []).filter((b) => service === "all" || b.variantId === service);
  const byDay = new Map<string, Booking[]>();
  for (const b of rows) {
    const d = localTime(new Date(b.startsAt), tz).date;
    byDay.set(d, [...(byDay.get(d) ?? []), b]);
  }
  const dayTitle = (d: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(
      zonedTime(d, 12 * 60, tz),
    );

  return (
    <div className="flex flex-col gap-6">
      {!enabled ? (
        <Panel className="flex flex-wrap items-center gap-3 border-warning bg-warning-soft text-[13px]">
          <Icon name="warning" size="sm" className="text-warning" />
          <span className="min-w-0 flex-1">
            Customers can't book on WhatsApp yet. Turn on Take bookings and set your opening hours.
          </span>
          <Button size="sm" variant="outline" asChild>
            <Link href="/agents?view=booking-settings">Booking settings</Link>
          </Button>
        </Panel>
      ) : null}
      {!services.length ? (
        <Panel className="flex flex-wrap items-center gap-3 text-[13px]">
          <Icon name="info" size="sm" className="text-muted-foreground" />
          <span className="min-w-0 flex-1">
            No service can be booked yet. Open a service in the catalogue, give it a length and turn on Can be
            booked.
          </span>
          <Button size="sm" variant="outline" asChild>
            <Link href="/agents?view=items">Catalogue</Link>
          </Button>
        </Panel>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" className="w-44">
          <TextInput type="date" value={startDay} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Service" className="w-56">
          <SelectField
            options={[
              { value: "all", label: "All services" },
              ...services.map((s) => ({ value: s.variantId, label: s.title })),
            ]}
            value={service}
            onValueChange={setService}
          />
        </Field>
        {day && day !== today ? (
          <Button variant="ghost" onClick={() => setDay("")}>
            Today
          </Button>
        ) : null}
        <Button className="ml-auto" disabled={!services.length} onClick={() => setAdding(true)}>
          <Icon name="add" size="sm" /> Add booking
        </Button>
      </div>

      {list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : !rows.length ? (
        <EmptyState
          icon={<Icon name="calendar" />}
          title="No bookings in these two weeks"
          description="Bookings Mira makes on WhatsApp and ones your team adds show here."
        />
      ) : (
        <div className="flex flex-col gap-5">
          {[...byDay.entries()].map(([d, items]) => (
            <section key={d} className="flex flex-col gap-2">
              <h2 className="text-[15px] font-semibold">
                {d === today ? "Today, " : ""}
                {dayTitle(d)}
                <span className="ml-2 text-[13px] font-normal text-muted-foreground">
                  {items.filter((b) => b.status !== "cancelled").length} booked
                </span>
              </h2>
              <Panel padding="none">
                <ul className="divide-y">
                  {items.map((b) => (
                    <BookingRow
                      key={b.id}
                      booking={b}
                      tz={tz}
                      onMove={() => setMoving(b)}
                      onInvite={() => setInviting(b)}
                    />
                  ))}
                </ul>
              </Panel>
            </section>
          ))}
        </div>
      )}
      {adding ? <AddBooking services={services} tz={tz} onClose={() => setAdding(false)} /> : null}
      {moving ? <MoveBooking booking={moving} tz={tz} onClose={() => setMoving(null)} /> : null}
      {inviting ? <BookingGuests booking={inviting} onClose={() => setInviting(null)} /> : null}
    </div>
  );
}

function BookingRow({
  booking: b,
  tz,
  onMove,
  onInvite,
}: {
  booking: Booking;
  tz: string;
  onMove: () => void;
  onInvite: () => void;
}) {
  const { update } = useBookingActions();
  const time = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
      .format(new Date(iso))
      .toLowerCase();
  const set = (status: BookingStatus) =>
    update.mutate(
      { id: b.id, status },
      {
        onSuccess: () => notify.success(statusLook[status].label),
        onError: (err) => notify.error("Not changed", { description: errorText(err) }),
      },
    );
  const done = b.status === "cancelled";
  return (
    <li className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 ${done ? "opacity-60" : ""}`}>
      <div className="w-28 shrink-0 text-sm font-medium tabular-nums">
        {time(b.startsAt)}
        <span className="block text-[12px] font-normal text-muted-foreground">to {time(b.endsAt)}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm font-medium ${done ? "line-through" : ""}`}>{b.title}</span>
          <Tag size="sm" tone={statusLook[b.status].tone}>
            {statusLook[b.status].label}
          </Tag>
          <Tag size="sm" tone={b.bookedBy === "ai" ? "ai" : "plain"}>
            {b.bookedBy === "ai" ? "By Mira" : "By the team"}
          </Tag>
        </div>
        <span className="text-[13px] text-muted-foreground">
          {b.conversationId ? (
            <Link
              className="underline-offset-2 hover:underline"
              href={`/conversations?view=all&c=${b.conversationId}`}
            >
              {b.contactName ?? b.contactPhone ?? "Customer"}
            </Link>
          ) : (
            (b.contactName ?? "Customer")
          )}
          {b.partySize ? ` · ${b.partySize} people` : ""} · Ref {b.reference}
          {b.notes ? ` · ${b.notes}` : ""}
        </span>
        {b.guestEmails.length ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
            <Icon name="mail" size="sm" />
            <span className="truncate">Invited {b.guestEmails.join(", ")}</span>
          </span>
        ) : null}
        {b.meetUrl || b.externalEventId || b.calendarSync === "failed" ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            {b.meetUrl ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(b.meetUrl ?? "");
                  notify.success("Meet link copied");
                }}
              >
                <Icon name="video" size="sm" /> Copy Meet link
              </button>
            ) : null}
            {b.calendarSync === "synced" && b.externalEventId ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="check" size="sm" /> In Google Calendar
              </span>
            ) : b.calendarSync === "failed" ? (
              <span
                className="inline-flex items-center gap-1 text-warning"
                title={b.calendarError ?? undefined}
              >
                <Icon name="warning" size="sm" /> Not in Google yet
                {b.calendarError ? `: ${b.calendarError.slice(0, 80)}` : ""}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {!done ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Change the ${b.title} booking`}
            className="rounded-md p-1.5 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Icon name="more" size="sm" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => set("arrived")}>Arrived</DropdownMenuItem>
            <DropdownMenuItem onClick={() => set("no_show")}>No-show</DropdownMenuItem>
            {b.status === "booked" ? (
              <DropdownMenuItem onClick={() => set("confirmed")}>Confirmed</DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={onMove}>Move to another time</DropdownMenuItem>
            <DropdownMenuItem onClick={onInvite}>Email invites</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => set("cancelled")}>
              Cancel booking
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

function TimePicker({
  variantId,
  date,
  value,
  onChange,
}: {
  variantId: string;
  date: string;
  value: string;
  onChange: (startsAt: string) => void;
}) {
  const times = useFreeTimes(variantId, date);
  if (!variantId || !date) return null;
  if (times.isPending) return <Skeleton className="h-9 w-full" />;
  if (times.data?.problem) return <p className="text-[13px] text-muted-foreground">{times.data.problem}</p>;
  if (!times.data?.times.length)
    return <p className="text-[13px] text-muted-foreground">Nothing free that day.</p>;
  return (
    <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0" aria-label="Free times">
      {times.data.times.map((t) => (
        <button
          key={t.startsAt}
          type="button"
          aria-pressed={value === t.startsAt}
          onClick={() => onChange(t.startsAt)}
          className={`rounded-md border px-2.5 py-1 text-[13px] tabular-nums focus-visible:outline-2 focus-visible:outline-ring ${
            value === t.startsAt ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"
          }`}
        >
          {t.label.split(", ")[1]}
        </button>
      ))}
    </fieldset>
  );
}

function AddBooking({
  services,
  tz,
  onClose,
}: {
  services: { variantId: string; title: string }[];
  tz: string;
  onClose: () => void;
}) {
  const { create } = useBookingActions();
  const [q, setQ] = useState("");
  const contacts = useBookingContacts(q);
  const [contactId, setContactId] = useState("");
  const [variantId, setVariantId] = useState(services[0]?.variantId ?? "");
  const [date, setDate] = useState(localTime(new Date(), tz).date);
  const [startsAt, setStartsAt] = useState("");
  const [people, setPeople] = useState("");
  const [notes, setNotes] = useState("");
  const [invites, setInvites] = useState("");
  const invitesWork = useInvitesWork();
  const guests = splitEmails(invites);
  const badGuest = guests.find((e) => !looksLikeEmail(e));
  const chosen = contacts.data?.contacts.find((c) => c.id === contactId);
  return (
    <SidePanel
      open
      onOpenChange={(open) => (open ? null : onClose())}
      title="Add a booking"
      description="Book a free time for a customer."
      footer={
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={create.isPending || !contactId || !variantId || !startsAt || !!badGuest}
            onClick={() =>
              create.mutate(
                {
                  variantId,
                  contactId,
                  startsAt,
                  ...(people ? { partySize: Number(people) } : {}),
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                  ...(invitesWork && guests.length ? { guestEmails: guests } : {}),
                },
                {
                  onSuccess: (r) => {
                    notify.success(`Booked for ${r.label}`);
                    onClose();
                  },
                  onError: (err) => notify.error("Not booked", { description: errorText(err) }),
                },
              )
            }
          >
            {create.isPending ? "Booking…" : "Book"}
          </Button>
        </ModalActions>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label="Customer"
          hint={
            chosen ? `${chosen.name}${chosen.phone ? ` · ${chosen.phone}` : ""}` : "Search by name or phone"
          }
        >
          <TextInput placeholder="Asha or 97150…" value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <div className="-mt-3 flex flex-col">
          {(contacts.data?.contacts ?? []).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setContactId(c.id)}
              className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent ${
                c.id === contactId ? "bg-accent font-medium" : ""
              }`}
            >
              <span>{c.name}</span>
              <span className="text-muted-foreground tabular-nums">{c.phone}</span>
            </button>
          ))}
        </div>
        <Field label="Service">
          <SelectField
            options={services.map((s) => ({ value: s.variantId, label: s.title }))}
            value={variantId}
            onValueChange={(v) => {
              setVariantId(v);
              setStartsAt("");
            }}
          />
        </Field>
        <Field label="Day">
          <TextInput
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setStartsAt("");
            }}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Time</span>
          <TimePicker variantId={variantId} date={date} value={startsAt} onChange={setStartsAt} />
        </div>
        <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
          <Field label="People" optional>
            <TextInput
              inputMode="numeric"
              value={people}
              onChange={(e) => setPeople(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label="Notes" optional>
            <TextArea minRows={1} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        {invitesWork ? (
          <Field
            label="Email invites"
            optional
            error={badGuest ? `${badGuest} isn't an email address.` : undefined}
            hint="Google Calendar emails each one an invite. Separate several with commas."
          >
            <TextInput
              type="text"
              inputMode="email"
              placeholder="name@example.com"
              value={invites}
              onChange={(e) => setInvites(e.target.value)}
            />
          </Field>
        ) : null}
      </div>
    </SidePanel>
  );
}

function MoveBooking({ booking, tz, onClose }: { booking: Booking; tz: string; onClose: () => void }) {
  const { update } = useBookingActions();
  const [date, setDate] = useState(localTime(new Date(booking.startsAt), tz).date);
  const [startsAt, setStartsAt] = useState("");
  return (
    <SidePanel
      open
      onOpenChange={(open) => (open ? null : onClose())}
      title={`Move ${booking.title}`}
      description={`Now ${booking.label}. Pick a free time; reminders follow the new time.`}
      footer={
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={update.isPending || !startsAt}
            onClick={() =>
              update.mutate(
                { id: booking.id, startsAt },
                {
                  onSuccess: () => {
                    notify.success("Moved");
                    onClose();
                  },
                  onError: (err) => notify.error("Not moved", { description: errorText(err) }),
                },
              )
            }
          >
            Move
          </Button>
        </ModalActions>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Day">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Time</span>
          <TimePicker
            variantId={booking.variantId ?? ""}
            date={date}
            value={startsAt}
            onChange={setStartsAt}
          />
        </div>
      </div>
    </SidePanel>
  );
}

function BookingGuests({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { update } = useBookingActions();
  const invitesWork = useInvitesWork();
  const [guests, setGuests] = useState<string[]>(booking.guestEmails);
  const [typed, setTyped] = useState("");
  const adding = splitEmails(typed).map((e) => e.toLowerCase());
  const bad = adding.find((e) => !looksLikeEmail(e));
  const add = () => {
    if (!adding.length || bad) return;
    setGuests((g) => [...new Set([...g, ...adding])]);
    setTyped("");
  };
  const next = bad ? guests : [...new Set([...guests, ...adding])];
  const changed = next.join() !== booking.guestEmails.join();
  return (
    <SidePanel
      open
      onOpenChange={(open) => (open ? null : onClose())}
      title="Email invites"
      description={`${booking.title}, ${booking.label}. Google Calendar emails each guest an invite${
        booking.meetUrl ? " with the Meet link" : ""
      }, and tells them if it moves or is cancelled.`}
      footer={
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={update.isPending || !changed || !!bad || !invitesWork}
            onClick={() =>
              update.mutate(
                { id: booking.id, guestEmails: next },
                {
                  onSuccess: (r) => {
                    const failed = (r as { calendar?: string }).calendar === "failed";
                    notify.success(failed ? "Saved. Google will get it shortly" : "Invites saved", {
                      description: failed
                        ? "Google didn't answer; Relay tries again in a minute."
                        : undefined,
                    });
                    onClose();
                  },
                  onError: (err) => notify.error("Not saved", { description: errorText(err) }),
                },
              )
            }
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </ModalActions>
      }
    >
      <div className="flex flex-col gap-5">
        {!invitesWork ? (
          <Panel className="flex flex-wrap items-center gap-3 text-[13px]">
            <Icon name="info" size="sm" className="text-muted-foreground" />
            <span className="min-w-0 flex-1">
              Invites are sent through Google Calendar. Connect it in Booking settings first.
            </span>
            <Button size="sm" variant="outline" asChild>
              <Link href="/agents?view=booking-settings">Booking settings</Link>
            </Button>
          </Panel>
        ) : null}
        <Field
          label="Add guests"
          error={bad ? `${bad} isn't an email address.` : undefined}
          hint="Separate several with commas."
        >
          <div className="flex gap-2">
            <TextInput
              type="text"
              inputMode="email"
              placeholder="name@example.com"
              value={typed}
              disabled={!invitesWork}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button variant="outline" disabled={!adding.length || !!bad || !invitesWork} onClick={add}>
              Add
            </Button>
          </div>
        </Field>
        {guests.length ? (
          <ul className="flex flex-col divide-y rounded-md border">
            {guests.map((g) => (
              <li key={g} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Icon name="mail" size="sm" className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{g}</span>
                <IconButton
                  icon="close"
                  size="sm"
                  label={`Remove ${g}`}
                  onClick={() => setGuests((all) => all.filter((x) => x !== g))}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">Nobody is invited by email yet.</p>
        )}
      </div>
    </SidePanel>
  );
}
