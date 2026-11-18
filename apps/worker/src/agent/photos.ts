import {
  defaultMonthlyCredits,
  type PhotoDescriber,
  type PhotosChoice,
  photoCredits,
  photoLimits,
  visionModelFor,
} from "@relay/agent";
import { type FileStorage, newId, type Publisher, publishInboxEvent } from "@relay/core";
import { aiCredits, type createDb, recordAiUsage } from "@relay/db";
import sharp from "sharp";
import { markMessage, storedFileOf, unhandledInbound } from "./attachments";

/*
 * Photos for the AI agent: before it answers, each of the customer's recent photos that hasn't been
 * looked at is described in words and saved on the message (`content.description`), so the agent can
 * search the catalogue with it and the team sees it under the photo in the inbox.
 *
 * Safe to run twice: a photo with a description (or a recorded reason it has none) is skipped, and
 * usage is unique per message, so a retried step never charges twice.
 */

type Db = ReturnType<typeof createDb>["db"];

/** Why a photo has no description; the agent's chat says so instead. */
export type PhotoSkip = "too_big" | "not_downloaded" | "failed" | "no_credits" | "too_many";

export type SeeArgs = {
  organizationId: string;
  branchId: string | null;
  conversationId: string;
  agentId: string;
  runId: string;
  choice: PhotosChoice;
  /** Unique per turn; each photo's usage row is keyed on it. */
  stepKey: string;
};

/** A phone photo shrunk to what a vision model needs: 1024 px on the long side, JPEG. */
async function shrink(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(bytes, { failOn: "none" })
      .rotate()
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

export function createPhotoReader({
  db,
  redis,
  storage,
  describe,
  now = () => Date.now(),
}: {
  db: Db;
  redis: Publisher;
  storage: FileStorage;
  describe: PhotoDescriber;
  now?: () => number;
}) {
  /** Looks at the customer's photos from the last 30 minutes. Returns how many were described. */
  return async function see(args: SeeArgs): Promise<number> {
    if (args.choice === "off") return 0;
    const photos = await unhandledInbound(
      db,
      args.conversationId,
      "image",
      "description",
      "descriptionSkipped",
      now(),
      10,
    );
    if (!photos.length) return 0;
    // The newest few are looked at; any more sent at once are marked, so they aren't picked up later.
    const extra = photos.slice(0, Math.max(0, photos.length - photoLimits.perTurn));
    for (const p of extra)
      await markMessage(db, p.id, { descriptionSkipped: "too_many" satisfies PhotoSkip });

    const { model, detail } = visionModelFor(args.choice);
    const credits = photoCredits(args.choice);
    const deadline = now() + photoLimits.waitMs;
    let seen = 0;
    for (const photo of photos.slice(extra.length)) {
      const skip = (reason: PhotoSkip) => markMessage(db, photo.id, { descriptionSkipped: reason });
      const file = await storedFileOf(db, photo.id, deadline, now);
      if (!file) {
        await skip("not_downloaded");
        continue;
      }
      if (file.size > photoLimits.maxBytes) {
        await skip("too_big");
        continue;
      }
      if ((await aiCredits(db, args.organizationId, defaultMonthlyCredits)).left < credits) {
        await skip("no_credits");
        continue;
      }
      const started = now();
      let result: Awaited<ReturnType<PhotoDescriber>>;
      try {
        result = await describe(await shrink(await storage.get(file.key)), model, detail);
        if (!result.text) throw new Error("empty description");
      } catch (err) {
        console.warn(`[agent] photo ${photo.id} not described:`, (err as Error).message);
        await skip("failed");
        continue;
      }
      await recordAiUsage(db, {
        id: newId("aiUsage"),
        organizationId: args.organizationId,
        branchId: args.branchId,
        agentId: args.agentId,
        conversationId: args.conversationId,
        runId: args.runId,
        stepKey: `${args.stepKey}:see:${photo.id}`,
        kind: "vision",
        model: result.model,
        inputTokens: result.usage.inputTokens,
        cachedTokens: result.usage.cachedTokens,
        outputTokens: result.usage.outputTokens,
        costMicros: result.costMicros,
        credits,
        latencyMs: now() - started,
      });
      await markMessage(db, photo.id, { description: result.text });
      await publishInboxEvent(redis, args.organizationId, {
        type: "message.updated",
        conversationId: args.conversationId,
        branchId: args.branchId,
        messageId: photo.id,
      });
      seen++;
    }
    return seen;
  };
}

export type PhotoReader = ReturnType<typeof createPhotoReader>;
