import { type Publisher, publishInboxEvent } from "@relay/core";
import { type createDb, schema, sql } from "@relay/db";

/*
 * Wakes snoozed conversations whose time has come. Runs every minute (a BullMQ job scheduler on the
 * "maintenance" queue). The lists already treat a past snooze as awake; this clears it and tells open
 * browsers, so the conversation shows up again live.
 */

type Db = ReturnType<typeof createDb>["db"];

export function createSnoozeWaker({ db, redis }: { db: Db; redis: Publisher }) {
  return async () => {
    const cv = schema.conversation;
    const woken = await db
      .update(cv)
      .set({ snoozedUntil: null, snoozedByUserId: null, updatedAt: new Date() })
      .where(sql`${cv.snoozedUntil} is not null and ${cv.snoozedUntil} <= (now() at time zone 'utc')`)
      .returning({ id: cv.id, organizationId: cv.organizationId, branchId: cv.branchId });
    for (const c of woken)
      await publishInboxEvent(redis, c.organizationId, {
        type: "conversation.updated",
        conversationId: c.id,
        branchId: c.branchId,
      });
    return { woken: woken.length };
  };
}
