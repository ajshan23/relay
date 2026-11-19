"use client";

import type { BookingSettings, BookingStatus } from "@relay/core/bookings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { api } from "@/lib/api";

/** The branch's bookings and booking settings (Relay's own booking book). */

export type BookableService = {
  itemId: string;
  variantId: string;
  title: string;
  durationMinutes: number;
  capacity: number;
};

export type BookingSettingsData = {
  settings: BookingSettings;
  timezone: string;
  services: BookableService[];
  templates: { id: string; name: string; ready: boolean | null }[];
  canManage: boolean;
};

export type Booking = {
  id: string;
  title: string;
  reference: string;
  startsAt: string;
  endsAt: string;
  label: string;
  partySize: number | null;
  notes: string;
  status: BookingStatus;
  bookedBy: "ai" | "team";
  meetUrl: string | null;
  externalEventId: string | null;
  calendarSync: "pending" | "synced" | "failed";
  calendarError: string | null;
  variantId: string | null;
  contactId: string | null;
  conversationId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  confirmedAt: string | null;
};

const keys = {
  all: (branch: string) => ["bookings", branch] as const,
  settings: (branch: string) => ["bookings", branch, "settings"] as const,
  list: (branch: string, from: string, to: string) => ["bookings", branch, "list", from, to] as const,
  times: (branch: string, variantId: string, date: string) =>
    ["bookings", branch, "times", variantId, date] as const,
  contacts: (branch: string, q: string) => ["bookings", branch, "contacts", q] as const,
};

const useBranchId = () => useBranch().branch.id;

export function useBookingSettings() {
  const branch = useBranchId();
  return useQuery({
    queryKey: keys.settings(branch),
    queryFn: () => api<BookingSettingsData>(inBranch("/bookings/settings", branch)),
    enabled: !!branch,
  });
}

export function useBookings(from: Date, to: Date) {
  const branch = useBranchId();
  const f = from.toISOString();
  const t = to.toISOString();
  return useQuery({
    queryKey: keys.list(branch, f, t),
    queryFn: () =>
      api<{ timezone: string; bookings: Booking[] }>(
        inBranch(`/bookings?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`, branch),
      ),
    enabled: !!branch,
    refetchInterval: 30_000,
  });
}

export function useFreeTimes(variantId: string, date: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: keys.times(branch, variantId, date),
    queryFn: () =>
      api<{ times: { startsAt: string; label: string }[]; problem: string | null }>(
        inBranch(`/bookings/times?variantId=${encodeURIComponent(variantId)}&date=${date}`, branch),
      ),
    enabled: !!branch && !!variantId && /^\d{4}-\d{2}-\d{2}$/.test(date),
  });
}

export function useBookingContacts(q: string) {
  const branch = useBranchId();
  return useQuery({
    queryKey: keys.contacts(branch, q),
    queryFn: () =>
      api<{ contacts: { id: string; name: string; phone: string | null }[] }>(
        inBranch(`/bookings/contacts?q=${encodeURIComponent(q)}`, branch),
      ),
    enabled: !!branch,
  });
}

export function useBookingActions() {
  const branch = useBranchId();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.all(branch) });
  return {
    saveSettings: useMutation({
      mutationFn: (settings: BookingSettings) =>
        api(inBranch("/bookings/settings", branch), { method: "PUT", json: settings }),
      onSuccess: refresh,
    }),
    create: useMutation({
      mutationFn: (body: {
        variantId: string;
        contactId: string;
        startsAt: string;
        partySize?: number | null;
        notes?: string;
      }) =>
        api<{ booking: Booking; label: string }>(inBranch("/bookings", branch), {
          method: "POST",
          json: body,
        }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string } & ({ status: BookingStatus } | { startsAt: string })) =>
        api(inBranch(`/bookings/${id}`, branch), { method: "PATCH", json: body }),
      onSuccess: refresh,
    }),
  };
}

// ------------------------------------------------------------------ Google Calendar

export type GoogleConnection = {
  accountEmail: string | null;
  calendarId: string | null;
  calendarName: string | null;
  calendars: { id: string; name: string; primary: boolean; timeZone: string | null }[];
  status: "pick_calendar" | "active" | "needs_reconnect";
  lastError: string | null;
  updatedAt: string;
};

export function useGoogleCalendar() {
  const branch = useBranchId();
  return useQuery({
    queryKey: ["bookings", branch, "google"] as const,
    queryFn: () =>
      api<{ configured: boolean; connection: GoogleConnection | null; canManage: boolean }>(
        inBranch("/bookings/google", branch),
      ),
    enabled: !!branch,
  });
}

export function useGoogleActions() {
  const branch = useBranchId();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.all(branch) });
  return {
    connect: useMutation({
      mutationFn: () =>
        api<{ url: string }>(inBranch("/bookings/google/connect", branch), { method: "POST" }),
      onSuccess: ({ url }) => {
        window.location.assign(url);
      },
    }),
    choose: useMutation({
      mutationFn: (calendarId: string) =>
        api(inBranch("/bookings/google", branch), { method: "PUT", json: { calendarId } }),
      onSuccess: refresh,
    }),
    reload: useMutation({
      mutationFn: () => api(inBranch("/bookings/google/calendars", branch), { method: "POST" }),
      onSuccess: refresh,
    }),
    disconnect: useMutation({
      mutationFn: () => api(inBranch("/bookings/google", branch), { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}
