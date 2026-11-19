import { newId, previewText } from "@relay/core";
import { bookingReplyId, bookingTimeLabel } from "@relay/core/bookings";
import { type TemplateContent, templateMessageContent, templateVariables } from "@relay/core/templates";
import {
  and,
  type CalendarDeps,
  type createDb,
  desc,
  eq,
  gt,
  inArray,
  insertOutboundMessage,
  lte,
  retryCalendarSyncs,
  schema,
  sql,
} from "@relay/db";
import type { Queue } from "bullmq";

/*
 * Booking reminders: a sweep every minute sends each reminder a branch set (1 day before, 2 hours
 * before…) once, for each booking still on. Inside the 24-hour window it's a message with Confirm /
 * Change buttons; outside it, the branch's approved reminder template with the same buttons.
 *
 * A reminder row (booking, its start time, hours before) is claimed before sending, so a reminder is
 * never sent twice, and a moved booking gets fresh reminders for its new time.
 */

type Db = ReturnType<typeof createDb>["db"];

export type ReminderDeps = {
  db: Db;
  /** Google Calendars: the sweep also retries bookings Google hasn't got yet. */
  calendar?: CalendarDeps | null;
  outbox: Pick<Queue, "add">;
  outboxJobOptions: Record<string, unknown>;
};

export type SweepResult = { sent: number; skipped: number };

/** Details a reminder template may use. */
const knownDetails = [
  "customer_name",
  "service",
  "date",
  "time",
  "branch",
  "business_name",
  "reference",
  "meet_link",
];

export function createBookingReminders(d: ReminderDeps) {
  const { db } = d;
  const B = schema.booking;

  async function sweep(now = new Date()): Promise<SweepResult> {
    const rows = await db
      .select({
        b: B,
        reminders: schema.bookingSetting.reminders,
        templateId: schema.bookingSetting.reminderTemplateId,
        onlineTemplateId: schema.bookingSetting.onlineReminderTemplateId,
        timezone: schema.branch.timezone,
        branchName: schema.branch.name,
        orgName: schema.organization.name,
        contactName: schema.contact.name,
      })
      .from(B)
      .innerJoin(schema.bookingSetting, eq(schema.bookingSetting.branchId, B.branchId))
      .innerJoin(schema.branch, eq(schema.branch.id, B.branchId))
      .innerJoin(schema.organization, eq(schema.organization.id, B.organizationId))
      .innerJoin(schema.contact, eq(schema.contact.id, B.contactId))
      .where(
        and(
          eq(schema.bookingSetting.enabled, true),
          inArray(B.status, ["booked", "confirmed"]),
          gt(B.startsAt, now),
          lte(B.startsAt, new Date(now.getTime() + 8 * 86_400_000)),
        ),
      )
      .limit(2000);
    const result: SweepResult = { sent: 0, skipped: 0 };
    // Bookings Google Calendar hasn't got right yet (Google was down, or the calendar was just connected).
    await retryCalendarSyncs(db, d.calendar, now).catch((err) =>
      console.warn("[bookings] calendar retry failed:", (err as Error).message),
    );
    for (const r of rows) {
      for (const rem of r.reminders) {
        if (!rem.enabled) continue;
        const at = r.b.startsAt.getTime() - rem.hoursBefore * 3_600_000;
        // Due, and the booking was made (or moved) before it was due: a late booking skips it.
        if (now.getTime() < at || r.b.updatedAt.getTime() > at + 60_000) continue;
        const outcome = await remind(r, rem.hoursBefore, now).catch((err) => {
          console.warn(`[bookings] reminder for ${r.b.id} failed: ${(err as Error).message}`);
          return null;
        });
        if (outcome === "sent") result.sent++;
        if (outcome === "skipped") result.skipped++;
      }
    }
    return result;
  }

  type Row = {
    b: typeof B.$inferSelect;
    templateId: string | null;
    onlineTemplateId: string | null;
    timezone: string;
    branchName: string;
    orgName: string;
    contactName: string | null;
  };

  async function remind(r: Row, hoursBefore: number, now: Date): Promise<"sent" | "skipped" | null> {
    const reminderId = newId("bookingReminder");
    const [claimed] = await db
      .insert(schema.bookingReminder)
      .values({ id: reminderId, bookingId: r.b.id, startsAt: r.b.startsAt, hoursBefore, outcome: "sent" })
      .onConflictDoNothing()
      .returning({ id: schema.bookingReminder.id });
    if (!claimed) return null;
    const skip = async (note: string) => {
      await db
        .update(schema.bookingReminder)
        .set({ outcome: "skipped", note })
        .where(eq(schema.bookingReminder.id, reminderId));
      return "skipped" as const;
    };
    const conv = await chatOf(r.b);
    if (!conv) return skip("The customer has no WhatsApp chat with this branch.");
    const [account] = await db
      .select({ status: schema.channelAccount.status })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, conv.channelAccountId))
      .limit(1);
    if (account?.status !== "active") return skip("The WhatsApp number isn't connected.");

    const tz = r.timezone || "UTC";
    const label = bookingTimeLabel(r.b.startsAt, tz);
    const name = r.contactName?.trim() || "there";
    const stepKey = `bkr:${r.b.id}:${r.b.startsAt.toISOString()}:${hoursBefore}`;
    const booking = { id: r.b.id, reference: r.b.reference };
    let type = "interactive";
    let content: Record<string, unknown>;
    if (conv.windowExpiresAt && conv.windowExpiresAt > now) {
      content = {
        type: "interactive",
        kind: "buttons",
        body: `Hi ${name}, a reminder of your ${r.b.title} on ${label}. Your reference is ${r.b.reference}.${
          r.b.meetUrl ? `\n\nJoin online: ${r.b.meetUrl}` : ""
        }`,
        buttonText: "Choose",
        options: [
          { id: bookingReplyId(r.b.id, "confirm"), title: "Confirm" },
          { id: bookingReplyId(r.b.id, "change"), title: "Change" },
        ],
        booking,
      };
    } else {
      // Online bookings use the online template (with the Meet link) when one is chosen.
      const templateId = (r.b.meetUrl && r.onlineTemplateId) || r.templateId;
      if (!templateId)
        return skip("Outside the 24-hour window, and no reminder template is chosen in Booking settings.");
      const [t] = await db
        .select({ template: schema.messageTemplate, copy: schema.templateChannel })
        .from(schema.messageTemplate)
        .innerJoin(
          schema.templateChannel,
          and(
            eq(schema.templateChannel.templateId, schema.messageTemplate.id),
            eq(schema.templateChannel.channelAccountId, conv.channelAccountId),
          ),
        )
        .where(eq(schema.messageTemplate.id, templateId))
        .limit(1);
      if (t?.copy.status !== "ready") return skip("The reminder template isn't approved on this number yet.");
      const date = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(r.b.startsAt);
      const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
        .format(r.b.startsAt)
        .toLowerCase();
      const details: Record<string, string> = {
        customer_name: name,
        service: r.b.title,
        date,
        time,
        branch: r.branchName,
        business_name: r.orgName,
        reference: r.b.reference,
        meet_link: r.b.meetUrl ?? "",
      };
      const needed = templateVariables(t.template.content as unknown as TemplateContent);
      if (needed.includes("meet_link") && !r.b.meetUrl)
        return skip("The reminder template needs a Meet link, and this booking has none.");
      const unknown = needed.filter((v) => !knownDetails.includes(v));
      if (unknown.length)
        return skip(
          `The reminder template uses details Relay can't fill: ${unknown.map((u) => `{{${u}}}`).join(", ")}.`,
        );
      content = templateMessageContent(
        t.template,
        Object.fromEntries(needed.map((v) => [v, details[v] ?? ""])),
      );
      // Its first two reply buttons answer Confirm and Change.
      const replies = (t.template.content as unknown as TemplateContent).buttons
        .map((b, index) => ({ b, index }))
        .filter((x) => x.b.kind === "reply");
      content.quickReplyPayloads = replies.slice(0, 2).map((x, i) => ({
        index: x.index,
        payload: bookingReplyId(r.b.id, i === 0 ? "confirm" : "change"),
      }));
      content.booking = booking;
      type = "template";
    }
    const { message } = await insertOutboundMessage(db, {
      id: newId("message"),
      conversation: conv,
      type,
      content,
      senderType: "bot",
      senderName: "Booking reminder",
      automationStepKey: stepKey,
    });
    if (message.status === "queued")
      await Promise.race([
        d.outbox.add("send", { messageId: message.id }, { jobId: message.id, ...d.outboxJobOptions }),
        new Promise((res) => setTimeout(res, 5_000)),
      ]).catch(() => {});
    await db
      .update(schema.bookingReminder)
      .set({ messageId: message.id, note: previewText(content)?.slice(0, 200) ?? null })
      .where(eq(schema.bookingReminder.id, reminderId));
    return "sent";
  }

  /** The chat the booking was made in, or the customer's latest chat with the branch. */
  async function chatOf(b: typeof B.$inferSelect) {
    const C = schema.conversation;
    if (b.conversationId) {
      const [c] = await db.select().from(C).where(eq(C.id, b.conversationId)).limit(1);
      if (c) return c;
    }
    if (!b.contactId) return null;
    const [c] = await db
      .select()
      .from(C)
      .where(and(eq(C.contactId, b.contactId), eq(C.branchId, b.branchId), eq(C.kind, "direct")))
      .orderBy(desc(sql`${C.lastMessageAt} nulls last`))
      .limit(1);
    return c ?? null;
  }

  /** Sweeps every minute until stopped. */
  function start(intervalMs = 60_000): () => void {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await sweep();
      } catch (err) {
        console.warn("[bookings] reminder sweep failed:", (err as Error).message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, intervalMs);
    void tick();
    return () => clearInterval(timer);
  }

  return { sweep, start };
}
