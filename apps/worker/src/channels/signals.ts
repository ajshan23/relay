import { GraphError } from "@relay/channels";
import type { SignalJob } from "@relay/core";
import { type createDb, eq, schema } from "@relay/db";
import { type Job, UnrecoverableError } from "bullmq";
import { accountRef, channels } from "./registry";

/*
 * Read receipts and "typing…" for the customer's app. The API decides when one is due (an agent opened
 * the conversation, or is typing) and checks the channel's setting; this sends it. A missed blue tick
 * or typing hint isn't worth much, so failures are dropped after one retry, except that a token that
 * stopped working marks the channel, like a failed send does.
 */

type Db = ReturnType<typeof createDb>["db"];

export function createSignalProcessor({ db }: { db: Db }) {
  return async (job: Job<SignalJob>) => {
    const { kind, messageId } = job.data;
    const [row] = await db
      .select({ message: schema.message, account: schema.channelAccount })
      .from(schema.message)
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.message.channelAccountId))
      .where(eq(schema.message.id, messageId))
      .limit(1);
    if (!row?.message.externalId || row.account.status !== "active") return;
    if (row.account.settings.readReceipts === false) return;
    const adapter = channels().get(row.account.type);
    if (!adapter?.markRead || !adapter.capabilities.readReceipts) return;
    try {
      await adapter.markRead(accountRef(row.account), row.message.externalId, { typing: kind === "typing" });
    } catch (err) {
      if (err instanceof GraphError && err.kind === "authFailed") {
        await db
          .update(schema.channelAccount)
          .set({ status: "error", statusReason: err.message, updatedAt: new Date() })
          .where(eq(schema.channelAccount.id, row.account.id));
        throw new UnrecoverableError(err.message);
      }
      // Typing is only useful right now; never retry it.
      if (kind === "typing" || !(err instanceof GraphError) || err.kind === "permanent")
        throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
}
