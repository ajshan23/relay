import { and, type createDb, desc, eq, gte, schema, sql } from "@relay/db";

/*
 * Shared by voice notes and photos: finding the customer's recent files the agent hasn't dealt with
 * yet, waiting for one that's still downloading, and saving what was found on the message.
 */

type Db = ReturnType<typeof createDb>["db"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Merges fields into a message's content (jsonb ||), e.g. a transcript or a photo's description. */
export async function markMessage(db: Db, messageId: string, patch: Record<string, unknown>) {
  await db
    .update(schema.message)
    .set({ content: sql`${schema.message.content} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(schema.message.id, messageId));
}

/**
 * The customer's messages of `type` from the last 30 minutes that have neither `doneKey` nor
 * `skippedKey` in their content, oldest first.
 */
export async function unhandledInbound(
  db: Db,
  conversationId: string,
  type: string,
  doneKey: string,
  skippedKey: string,
  now: number,
  limit: number,
) {
  const m = schema.message;
  const rows = await db
    .select({ id: m.id, content: m.content })
    .from(m)
    .where(
      and(
        eq(m.conversationId, conversationId),
        eq(m.direction, "inbound"),
        eq(m.type, type),
        gte(m.sentAt, new Date(now - 30 * 60_000)),
        sql`not (${m.content} ? ${doneKey})`,
        sql`not (${m.content} ? ${skippedKey})`,
      ),
    )
    .orderBy(desc(m.sentAt))
    .limit(limit);
  return rows.reverse();
}

/** The stored file of a message, waiting while it's still being downloaded (null: failed or too slow). */
export async function storedFileOf(db: Db, messageId: string, deadline: number, now: () => number) {
  for (;;) {
    const [a] = await db
      .select({
        status: schema.attachment.status,
        key: schema.storedFile.storageKey,
        size: schema.storedFile.sizeBytes,
      })
      .from(schema.attachment)
      .leftJoin(schema.storedFile, eq(schema.storedFile.id, schema.attachment.fileId))
      .where(eq(schema.attachment.messageId, messageId))
      .limit(1);
    if (a?.status === "stored" && a.key) return { key: a.key, size: Number(a.size ?? 0) };
    if (a?.status === "failed" || now() >= deadline) return null;
    await sleep(1000);
  }
}
