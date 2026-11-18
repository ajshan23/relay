import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultMonthlyCredits,
  type Transcriber,
  transcribeCostMicros,
  transcribeCredits,
  transcribeModelFor,
  type VoiceNotesChoice,
  voiceNoteLimits,
} from "@relay/agent";
import { type FileStorage, newId, type Publisher, publishInboxEvent } from "@relay/core";
import { aiCredits, and, type createDb, desc, eq, gte, recordAiUsage, schema, sql } from "@relay/db";
import { probe } from "../catalog/media";

/*
 * Voice notes for the AI agent: before it answers, each of the customer's recent voice notes that
 * hasn't been heard yet is turned into text and saved on the message (`content.transcript`), so the
 * agent reads it like a typed message and the team sees it under the player in the inbox.
 *
 * Safe to run twice: a note that already has a transcript (or a recorded reason it has none) is
 * skipped, and usage is unique per message, so a retried step never charges twice.
 */

type Db = ReturnType<typeof createDb>["db"];

/** Why a voice note has no transcript; the agent's chat says so instead of the text. */
export type VoiceSkip = "too_long" | "not_downloaded" | "failed" | "no_credits";

export type HearArgs = {
  organizationId: string;
  branchId: string | null;
  conversationId: string;
  agentId: string;
  runId: string;
  choice: VoiceNotesChoice;
  /** Unique per turn; each note's usage row is keyed on it. */
  stepKey: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createVoiceListener({
  db,
  redis,
  storage,
  transcribe,
  now = () => Date.now(),
}: {
  db: Db;
  redis: Publisher;
  storage: FileStorage;
  transcribe: Transcriber;
  now?: () => number;
}) {
  /** Length in seconds, from the file itself (WhatsApp doesn't say). Falls back to ~16 kbit/s Opus. */
  async function secondsOf(bytes: Uint8Array): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), "relay-voice-"));
    try {
      const path = join(dir, "note");
      await writeFile(path, bytes);
      const s = (await probe(path)).seconds;
      if (s > 0) return s;
    } catch {
      // ffprobe missing or the file is odd: estimate below.
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return bytes.byteLength / 2000;
  }

  async function mark(messageId: string, patch: Record<string, unknown>) {
    await db
      .update(schema.message)
      .set({ content: sql`${schema.message.content} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(schema.message.id, messageId));
  }

  /** The stored file of a voice note, waiting a little while it's still being downloaded. */
  async function storedAudio(messageId: string, deadline: number) {
    for (;;) {
      const [a] = await db
        .select({ status: schema.attachment.status, key: schema.storedFile.storageKey })
        .from(schema.attachment)
        .leftJoin(schema.storedFile, eq(schema.storedFile.id, schema.attachment.fileId))
        .where(eq(schema.attachment.messageId, messageId))
        .limit(1);
      if (a?.status === "stored" && a.key) return a.key;
      if (a?.status === "failed" || now() >= deadline) return null;
      await sleep(1000);
    }
  }

  /** Hears every voice note from the last 30 minutes that hasn't been heard. Returns how many got text. */
  return async function hear(args: HearArgs): Promise<number> {
    if (args.choice === "off") return 0;
    const m = schema.message;
    const notes = await db
      .select({ id: m.id, content: m.content })
      .from(m)
      .where(
        and(
          eq(m.conversationId, args.conversationId),
          eq(m.direction, "inbound"),
          eq(m.type, "audio"),
          gte(m.sentAt, new Date(now() - 30 * 60_000)),
          sql`not (${m.content} ? 'transcript')`,
          sql`not (${m.content} ? 'transcriptSkipped')`,
        ),
      )
      .orderBy(desc(m.sentAt))
      .limit(5);
    if (!notes.length) return 0;

    const model = transcribeModelFor(args.choice);
    const deadline = now() + voiceNoteLimits.waitMs;
    let heard = 0;
    for (const note of notes.reverse()) {
      const skip = (reason: VoiceSkip) => mark(note.id, { transcriptSkipped: reason });
      const key = await storedAudio(note.id, deadline);
      if (!key) {
        await skip("not_downloaded");
        continue;
      }
      const bytes = await storage.get(key);
      const seconds = await secondsOf(bytes);
      if (seconds > voiceNoteLimits.maxSeconds) {
        await skip("too_long");
        continue;
      }
      const credits = transcribeCredits(args.choice, seconds);
      if ((await aiCredits(db, args.organizationId, defaultMonthlyCredits)).left < credits) {
        await skip("no_credits");
        continue;
      }
      const started = now();
      let text: string;
      let language: string | null;
      try {
        ({ text, language } = await transcribe(bytes, model));
      } catch (err) {
        console.warn(`[agent] voice note ${note.id} not transcribed:`, (err as Error).message);
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
        stepKey: `${args.stepKey}:hear:${note.id}`,
        kind: "transcribe",
        model,
        costMicros: transcribeCostMicros(model, seconds),
        credits,
        latencyMs: now() - started,
      });
      await mark(note.id, {
        transcript: text,
        transcriptLanguage: language,
        transcriptSeconds: Math.round(seconds),
      });
      await publishInboxEvent(redis, args.organizationId, {
        type: "message.updated",
        conversationId: args.conversationId,
        branchId: args.branchId,
        messageId: note.id,
      });
      heard++;
    }
    return heard;
  };
}

export type VoiceListener = ReturnType<typeof createVoiceListener>;
