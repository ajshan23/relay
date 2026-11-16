import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import type { DbOrTx } from "./executor";
import { trackedLink } from "./schema/automations";

export type TappedLink = typeof trackedLink.$inferSelect;

/**
 * A tap on a tracked link: counts it and returns where it goes (null for an unknown code). The first
 * tap also runs `onFirstTap` in the same transaction (to wake the run waiting for it), so a tap is
 * never counted without its run hearing about it.
 */
export async function recordLinkTap(
  db: Db,
  code: string,
  onFirstTap: (tx: DbOrTx, link: TappedLink) => Promise<void>,
): Promise<{ url: string } | null> {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select()
      .from(trackedLink)
      .where(eq(trackedLink.code, code))
      .for("update")
      .limit(1);
    if (!link) return null;
    const first = !link.firstTappedAt;
    await tx
      .update(trackedLink)
      .set({
        tapCount: sql`${trackedLink.tapCount} + 1`,
        ...(first ? { firstTappedAt: new Date() } : {}),
      })
      .where(eq(trackedLink.id, link.id));
    if (first) await onFirstTap(tx, link);
    return { url: link.url };
  });
}
