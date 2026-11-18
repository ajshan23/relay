import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../catalog/media";

/*
 * Voice replies: the speech service returns MP3; WhatsApp shows a voice note (the green mic bubble)
 * only for Ogg/Opus mono, so it's converted the same way voice notes recorded in Relay are.
 */

export async function toVoiceNote(audio: Uint8Array): Promise<{ bytes: Uint8Array; seconds: number | null }> {
  const dir = await mkdtemp(join(tmpdir(), "relay-speech-"));
  try {
    const src = join(dir, "in.mp3");
    const out = join(dir, "out.ogg");
    await writeFile(src, audio);
    await run(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner",
      "-y",
      "-i",
      src,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-application",
      "voip",
      "-f",
      "ogg",
      out,
    ]);
    const bytes = new Uint8Array(await readFile(out));
    let seconds: number | null = null;
    try {
      const probe = await run(process.env.FFPROBE_PATH || "ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        out,
      ]);
      seconds = Number(probe.trim()) || null;
    } catch {
      // The length is only for the chat's player.
    }
    return { bytes, seconds };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
