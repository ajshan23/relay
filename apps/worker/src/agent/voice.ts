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
import { aiCredits, type createDb, recordAiUsage } from "@relay/db";
import { probe } from "../catalog/media";
import { markMessage, storedFileOf, unhandledInbound } from "./attachments";

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

  /** Hears every voice note from the last 30 minutes that hasn't been heard. Returns how many got text. */
  return async function hear(args: HearArgs): Promise<number> {
    if (args.choice === "off") return 0;
    const notes = await unhandledInbound(
      db,
      args.conversationId,
      "audio",
      "transcript",
      "transcriptSkipped",
      now(),
      5,
    );
    if (!notes.length) return 0;

    const model = transcribeModelFor(args.choice);
    const deadline = now() + voiceNoteLimits.waitMs;
    let heard = 0;
    for (const note of notes) {
      const skip = (reason: VoiceSkip) => markMessage(db, note.id, { transcriptSkipped: reason });
      const file = await storedFileOf(db, note.id, deadline, now);
      if (!file) {
        await skip("not_downloaded");
        continue;
      }
      const bytes = await storage.get(file.key);
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
      let used = model;
      try {
        ({ text, language, model: used } = await transcribe(bytes, model));
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
        model: used,
        costMicros: transcribeCostMicros(used, seconds),
        credits,
        latencyMs: now() - started,
      });
      await markMessage(db, note.id, {
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
