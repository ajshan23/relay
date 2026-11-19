import { z } from "zod";
import { defineTool } from "./tools";
import type { AgentTool, RunContext } from "./types";

/*
 * Booking tools: find free times for a service, book one (the customer taps Yes first), and look up,
 * move or cancel the customer's bookings. Times are always a local date and time in the branch's
 * timezone, so the model can read them back from what it offered in the chat.
 */

export const bookingToolNames = {
  find: "find_times",
  book: "book_time",
  mine: "my_bookings",
  move: "move_booking",
  cancel: "cancel_booking",
} as const;

/** The `ref` of the built-in booking tools that ask first (confirm tools). */
export const bookingToolRef = { toolId: "builtin:booking", title: "Booking" } as const;

export type BookingServiceInfo = {
  variantId: string;
  itemId: string;
  title: string;
  durationMinutes: number;
};

export type BookingDeps = {
  services: BookingServiceInfo[];
  timezone: string;
  findTimes: (
    input: { variantId: string; date?: string; partOfDay?: "morning" | "afternoon" | "evening" },
    ctx: RunContext,
  ) => Promise<unknown>;
  book: (
    input: { variantId: string; date: string; time: string; partySize?: number; notes?: string },
    ctx: RunContext,
  ) => Promise<unknown>;
  myBookings: (ctx: RunContext) => Promise<unknown>;
  move: (input: { reference: string; date: string; time: string }, ctx: RunContext) => Promise<unknown>;
  cancel: (input: { reference: string }, ctx: RunContext) => Promise<unknown>;
};

const question = z
  .string()
  .min(2)
  .max(300)
  .describe("The Yes / No question for the customer, in their language, with the service, day and time");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Local date, YYYY-MM-DD");
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe("Local time, 24-hour HH:MM, exactly as one of the free times");
const reference = z.string().min(4).max(12).describe("The booking's reference, from my_bookings");

/** Finds a service by variant or item id (an item's first bookable option). */
export function serviceOf(services: BookingServiceInfo[], id: string): BookingServiceInfo | undefined {
  return services.find((s) => s.variantId === id) ?? services.find((s) => s.itemId === id);
}

export function bookingTools(deps: BookingDeps): AgentTool<unknown>[] {
  const list = deps.services
    .slice(0, 60)
    .map((s) => `${s.variantId} = ${s.title} (${s.durationMinutes} min)`)
    .join("; ");
  const service = z
    .string()
    .min(3)
    .max(60)
    .describe("The service id from the list (or the item id of a card)");
  const resolve = (id: string) => {
    const s = serviceOf(deps.services, id);
    if (!s) throw new Error("That isn't one of the services that can be booked. Use an id from the list.");
    return s.variantId;
  };
  return [
    defineTool({
      name: bookingToolNames.find,
      kind: "read",
      description: `Find free times for a service that can be booked. Use it when someone wants to book (or taps Book on a service), before offering any time. Times are in ${deps.timezone}. Services: ${list}.`,
      input: z.object({
        service,
        date: date.optional().describe("The day they want, YYYY-MM-DD. Leave out for the next free times."),
        partOfDay: z.enum(["morning", "afternoon", "evening"]).optional(),
      }),
      run: ({ service: id, ...rest }, ctx) => deps.findTimes({ variantId: resolve(id), ...rest }, ctx),
    }),
    defineTool({
      name: bookingToolNames.book,
      kind: "confirm",
      ref: { ...bookingToolRef },
      description:
        "Book a free time for the customer once they've chosen one from find_times. They are asked to tap Yes first; it's booked only after that. Never say it's booked until you see the result.",
      input: z.object({
        service,
        date,
        time,
        partySize: z.number().int().min(1).max(500).optional().describe("How many people, when it matters"),
        notes: z.string().max(300).optional().describe("Anything the business should know"),
        confirmText: question,
      }),
      run: ({ service: id, confirmText: _q, ...rest }, ctx) =>
        deps.book({ variantId: resolve(id), ...rest }, ctx),
    }),
    defineTool({
      name: bookingToolNames.mine,
      kind: "read",
      description:
        "The customer's upcoming bookings (service, day, time, reference). Use it before changing or cancelling one.",
      input: z.object({}),
      run: (_i, ctx) => deps.myBookings(ctx),
    }),
    defineTool({
      name: bookingToolNames.move,
      kind: "confirm",
      ref: { ...bookingToolRef },
      description:
        "Move one of the customer's bookings to another free time (check it with find_times first). They are asked to tap Yes first.",
      input: z.object({ reference, date, time, confirmText: question }),
      run: ({ confirmText: _q, ...rest }, ctx) => deps.move(rest, ctx),
    }),
    defineTool({
      name: bookingToolNames.cancel,
      kind: "confirm",
      ref: { ...bookingToolRef },
      description: "Cancel one of the customer's bookings. They are asked to tap Yes first.",
      input: z.object({ reference, confirmText: question }),
      run: ({ confirmText: _q, ...rest }, ctx) => deps.cancel(rest, ctx),
    }),
  ];
}
