import { createHash } from "node:crypto";
import { GraphError } from "@relay/channels";
import { env, localFileStorage, type Publisher, publishInboxEvent } from "@relay/core";
import { type createDb, eq, schema } from "@relay/db";
import { type Job, UnrecoverableError } from "bullmq";
import { accountRef, channels } from "./registry";
import type { MediaJob } from "./webhooks";

type Db = ReturnType<typeof createDb>["db"];

const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "application/pdf": "pdf",
};

/**
 * Copies one customer file from the channel into our storage, through its adapter. Provider links
 * expire quickly (WhatsApp: 5 minutes, ids 7 days), so this runs right after the message arrives.
 */
export function createMediaProcessor({ db, redis }: { db: Db; redis: Publisher }) {
  const config = env();
  const storage = localFileStorage(config.MEDIA_DIR);

  return async function downloadMedia(job: Job<MediaJob>) {
    const [row] = await db
      .select({
        attachment: schema.attachment,
        account: schema.channelAccount,
        conversation: schema.conversation,
      })
      .from(schema.attachment)
      .innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
      .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.message.channelAccountId))
      .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
      .where(eq(schema.attachment.id, job.data.attachmentId))
      .limit(1);
    if (!row || row.attachment.status === "stored") return;
    const { attachment, account, conversation } = row;
    const announce = () =>
      publishInboxEvent(redis, conversation.organizationId, {
        type: "message.updated",
        conversationId: conversation.id,
        branchId: conversation.branchId,
        messageId: attachment.messageId ?? "",
      });
    const mediaId = attachment.providerMediaId;
    if (!mediaId) return;

    const markFailed = (error: string) =>
      db
        .update(schema.attachment)
        .set({ status: "failed", error })
        .where(eq(schema.attachment.id, attachment.id));

    try {
      const adapter = channels().get(account.type);
      if (!adapter) throw new UnrecoverableError(`No adapter for ${account.type}`);
      const limits = adapter.capabilities.media as Record<string, { maxBytes: number }>;
      const maxBytes = limits[attachment.kind]?.maxBytes ?? 100 * 1024 * 1024;
      const file = await adapter.fetchMedia(accountRef(account), mediaId, maxBytes);

      const mimeType =
        file.mimeType?.split(";")[0]?.trim() ?? attachment.mimeType ?? "application/octet-stream";
      const extension = extensions[mimeType] ?? attachment.fileName?.split(".").pop() ?? "bin";
      const now = new Date();
      const key = `${attachment.organizationId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${attachment.id}.${extension}`;
      await storage.put(key, file.bytes);
      await db
        .update(schema.attachment)
        .set({
          status: "stored",
          storageKey: key,
          mimeType,
          sizeBytes: file.bytes.byteLength,
          sha256: attachment.sha256 ?? createHash("sha256").update(file.bytes).digest("base64"),
          error: null,
        })
        .where(eq(schema.attachment.id, attachment.id));
      await announce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (err instanceof GraphError && (err.kind === "permanent" || err.kind === "authFailed")) {
        await markFailed(message);
        await announce();
        throw new UnrecoverableError(message);
      }
      if (lastAttempt) {
        await markFailed(message);
        await announce();
      }
      throw err;
    }
  };
}
