import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Voice notes recorded in the browser (Chrome: WebM/Opus, Safari: MP4/AAC, Firefox: Ogg/Opus) are
 * converted to what WhatsApp shows as a voice message: Ogg with the Opus codec, mono. 24 kbit/s
 * keeps about 2.5 minutes under WhatsApp's 512 KB inline-play size.
 * Needs the ffmpeg program (FFMPEG_PATH, default "ffmpeg" on PATH), like video previews.
 */

export class FfmpegMissing extends Error {}

export async function toVoiceNote(input: Uint8Array): Promise<{ bytes: Uint8Array; seconds: number | null }> {
  const base = join(tmpdir(), `relay-voice-${randomUUID()}`);
  const src = `${base}.in`;
  const out = `${base}.ogg`;
  await writeFile(src, input);
  try {
    const stderr = await run([
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
      "24k",
      "-application",
      "voip",
      "-f",
      "ogg",
      out,
    ]);
    const bytes = new Uint8Array(await readFile(out));
    // ffmpeg reports the input length as "Duration: 00:00:07.52".
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
    return { bytes, seconds };
  } finally {
    await rm(src, { force: true });
    await rm(out, { force: true });
  }
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      if (stderr.length < 20_000) stderr += String(d);
    });
    proc.on("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "ENOENT" ? new FfmpegMissing("ffmpeg is not installed on the server") : err),
    );
    proc.on("close", (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg failed: ${stderr.slice(-300)}`)),
    );
  });
}
