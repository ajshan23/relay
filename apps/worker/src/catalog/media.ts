import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileStorage, newId } from "@relay/core";
import { catalogMediaLimits } from "@relay/core/catalog";
import { type createDb, eq, releaseStorage, schema, storeFile } from "@relay/db";
import type { Job, Queue } from "bullmq";
import sharp from "sharp";

/*
 * Prepares one uploaded catalogue file for WhatsApp (queue "catalog-media", job "prepare", id = media
 * id), so sending never waits and never fails on format:
 *   image     JPEG, longest side 2048 px, under 5 MB
 *   video     MP4 (H.264 + AAC) under 16 MB; converted (720p, bitrate fitted to the length) if needed
 *   audio     MP3 or AAC under 16 MB; converted to MP3 if needed
 *   document  PDF, up to 100 MB, as is
 * The prepared file is stored once per business (by content) and the upload is deleted. Space was
 * reserved for the upload's size when it started; it's swapped for the prepared file's real size here.
 * ffmpeg and ffprobe come from FFMPEG_PATH / FFPROBE_PATH (default: on PATH).
 */

type Db = ReturnType<typeof createDb>["db"];
export type MediaJob = { mediaId: string };

class NotUsable extends Error {}

const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = () => process.env.FFPROBE_PATH || "ffprobe";

export function run(cmd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
    });
    p.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new Error(`${cmd} isn't installed on the server`) : e),
    );
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.slice(-300)}`)),
    );
  });
}

type Probe = {
  container: string;
  video?: string;
  audio?: string;
  seconds: number;
  width?: number;
  height?: number;
};

export async function probe(path: string): Promise<Probe> {
  const json = JSON.parse(
    await run(ffprobe(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]),
  ) as {
    format?: { format_name?: string; duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
  };
  const v = json.streams?.find((s) => s.codec_type === "video");
  const a = json.streams?.find((s) => s.codec_type === "audio");
  return {
    container: json.format?.format_name ?? "",
    video: v?.codec_name,
    audio: a?.codec_name,
    seconds: Number(json.format?.duration ?? 0),
    width: v?.width,
    height: v?.height,
  };
}

async function prepareImage(bytes: Uint8Array) {
  const max = catalogMediaLimits.sendMaxBytes.image;
  for (const [side, quality] of [
    [2048, 85],
    [2048, 72],
    [1600, 70],
    [1280, 65],
  ] as const) {
    const { data, info } = await sharp(bytes, { failOn: "none" })
      .rotate()
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength <= max)
      return { bytes: new Uint8Array(data), mimeType: "image/jpeg", width: info.width, height: info.height };
  }
  throw new NotUsable("This photo is too detailed to send on WhatsApp. Try a smaller one.");
}

async function prepareVideo(bytes: Uint8Array, dir: string) {
  const max = catalogMediaLimits.sendMaxBytes.video;
  const input = join(dir, "in");
  await writeFile(input, bytes);
  const p = await probe(input);
  if (!p.video) throw new NotUsable("That file has no video in it.");
  const ready =
    p.container.includes("mp4") &&
    p.video === "h264" &&
    (!p.audio || p.audio === "aac") &&
    bytes.byteLength <= max;
  if (ready) return { bytes, mimeType: "video/mp4", width: p.width, height: p.height, seconds: p.seconds };
  // Fit the whole video under the limit: total bits / length, minus the sound, with some room.
  const seconds = Math.max(p.seconds, 1);
  const audioKbps = p.audio ? 96 : 0;
  const videoKbps = Math.floor((max * 0.92 * 8) / 1000 / seconds - audioKbps);
  if (videoKbps < 250)
    throw new NotUsable(
      `This video is too long to send on WhatsApp in good quality (about ${Math.floor((max * 0.92 * 8) / 1000 / 350 / 60)} minutes at most). Trim it and try again.`,
    );
  const kbps = Math.min(videoKbps, 2500);
  const output = join(dir, "out.mp4");
  await run(ffmpeg(), [
    "-y",
    "-i",
    input,
    "-vf",
    "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "main",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    `${kbps}k`,
    "-maxrate",
    `${Math.floor(kbps * 1.2)}k`,
    "-bufsize",
    `${kbps * 2}k`,
    ...(p.audio ? ["-c:a", "aac", "-b:a", `${audioKbps}k`] : ["-an"]),
    "-movflags",
    "+faststart",
    output,
  ]);
  const out = new Uint8Array(await readFile(output));
  if (out.byteLength > max)
    throw new NotUsable("This video is too long to send on WhatsApp. Trim it and try again.");
  const q = await probe(output);
  return { bytes: out, mimeType: "video/mp4", width: q.width, height: q.height, seconds: q.seconds };
}

async function prepareAudio(bytes: Uint8Array, mimeType: string, dir: string) {
  const max = catalogMediaLimits.sendMaxBytes.audio;
  if (["audio/mpeg", "audio/mp3", "audio/aac", "audio/mp4"].includes(mimeType) && bytes.byteLength <= max) {
    const input = join(dir, "in");
    await writeFile(input, bytes);
    const p = await probe(input).catch(() => null);
    return { bytes, mimeType: mimeType === "audio/mp3" ? "audio/mpeg" : mimeType, seconds: p?.seconds };
  }
  const input = join(dir, "in");
  const output = join(dir, "out.mp3");
  await writeFile(input, bytes);
  await run(ffmpeg(), ["-y", "-i", input, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", output]);
  const out = new Uint8Array(await readFile(output));
  if (out.byteLength > max) throw new NotUsable("This recording is too long to send on WhatsApp.");
  const p = await probe(output).catch(() => null);
  return { bytes: out, mimeType: "audio/mpeg", seconds: p?.seconds };
}

export function createCatalogMediaProcessor(deps: { db: Db; storage: FileStorage; previews?: Queue }) {
  const { db, storage } = deps;
  const M = schema.catalogMedia;

  async function fail(media: typeof M.$inferSelect, message: string) {
    await db
      .update(M)
      .set({ status: "failed", error: message.slice(0, 300), reservedBytes: 0, updatedAt: new Date() })
      .where(eq(M.id, media.id));
    await releaseStorage(db, media.organizationId, media.reservedBytes);
    if (media.uploadKey) await storage.delete(media.uploadKey).catch(() => {});
  }

  return async (job: Job<MediaJob>) => {
    const [media] = await db.select().from(M).where(eq(M.id, job.data.mediaId)).limit(1);
    if (media?.status !== "processing" || !media.uploadKey) return;
    let bytes: Uint8Array;
    try {
      bytes = await storage.get(media.uploadKey);
    } catch {
      // The browser never finished the upload (or it was cleaned up): nothing to prepare.
      await fail(media, "The upload didn't arrive. Try again.");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "relay-media-"));
    try {
      const mime = (media.mimeType ?? "").toLowerCase();
      let prepared: {
        bytes: Uint8Array;
        mimeType: string;
        width?: number;
        height?: number;
        seconds?: number;
      };
      if (media.kind === "image") prepared = await prepareImage(bytes);
      else if (media.kind === "video") prepared = await prepareVideo(bytes, dir);
      else if (media.kind === "audio") prepared = await prepareAudio(bytes, mime, dir);
      else {
        if (mime !== "application/pdf") throw new NotUsable("Only PDF documents can be sent.");
        if (bytes.byteLength > catalogMediaLimits.sendMaxBytes.document)
          throw new NotUsable("Documents can be up to 100 MB.");
        prepared = { bytes, mimeType: "application/pdf" };
      }
      // The reservation covered the upload; count the prepared file instead.
      const { file } = await storeFile(db, storage, {
        organizationId: media.organizationId,
        bytes: prepared.bytes,
        mimeType: prepared.mimeType,
        newId: () => newId("storedFile"),
        quota: "count",
      });
      await db
        .update(M)
        .set({
          fileId: file.id,
          mimeType: prepared.mimeType,
          sizeBytes: prepared.bytes.byteLength,
          width: prepared.width ?? null,
          height: prepared.height ?? null,
          durationSeconds: prepared.seconds ? Math.round(prepared.seconds) : null,
          status: "ready",
          error: null,
          uploadKey: null,
          reservedBytes: 0,
          updatedAt: new Date(),
        })
        .where(eq(M.id, media.id));
      await releaseStorage(db, media.organizationId, media.reservedBytes);
      await storage.delete(media.uploadKey).catch(() => {});
      if ((media.kind === "image" || media.kind === "video") && !file.previewKey && deps.previews)
        await deps.previews.add("preview", { fileId: file.id }, { jobId: `preview_${file.id}`, attempts: 2 });
    } catch (err) {
      if (err instanceof NotUsable) await fail(media, err.message);
      else if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        console.warn(`catalog media ${media.id} failed: ${(err as Error).message}`);
        await fail(media, "This file couldn't be prepared for WhatsApp. Try another file.");
      } else throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
