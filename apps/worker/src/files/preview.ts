import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileStorage, PreviewJob } from "@relay/core";
import { type createDb, eq, schema } from "@relay/db";
import type { Job } from "bullmq";
import sharp from "sharp";

/*
 * Small previews for the chat: a 480 px wide WebP of every stored image, and of one frame of every
 * video. Opening a conversation then downloads previews (tens of KB) instead of whole files; the full
 * file loads only when someone opens it. Originals are never changed.
 *
 * Video frames need the ffmpeg program (FFMPEG_PATH, default "ffmpeg" on PATH). Without it, videos
 * simply have no preview and the chat shows a plain video tile.
 */

type Db = ReturnType<typeof createDb>["db"];
const WIDTH = 480;
/** Images already this small (and narrow) are their own preview. */
const SMALL_BYTES = 60 * 1024;

let ffmpegMissing = false;

/** The first frame after one second (or the very first, for short clips), as PNG bytes. */
async function videoFrame(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (ffmpegMissing) return null;
  const dir = await mkdtemp(join(tmpdir(), "relay-frame-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, "frame.png");
    await writeFile(input, bytes);
    const run = (seek: string) =>
      new Promise<boolean>((resolve) => {
        const p = spawn(
          process.env.FFMPEG_PATH || "ffmpeg",
          ["-v", "error", "-y", "-ss", seek, "-i", input, "-frames:v", "1", output],
          { stdio: "ignore" },
        );
        p.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            ffmpegMissing = true;
            console.warn("previews: ffmpeg isn't installed, so videos get no preview");
          }
          resolve(false);
        });
        p.on("exit", (code) => resolve(code === 0));
      });
    if (!(await run("1")) && !ffmpegMissing) await run("0");
    return await readFile(output).catch(() => null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createPreviewProcessor({ db, storage }: { db: Db; storage: FileStorage }) {
  const f = schema.storedFile;
  return async (job: Job<PreviewJob>) => {
    const [file] = await db.select().from(f).where(eq(f.id, job.data.fileId)).limit(1);
    if (!file || file.previewKey) return { skipped: "done" };
    const mime = file.mimeType ?? "";
    const isImage = /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(mime);
    const isVideo = mime.startsWith("video/");
    if (!isImage && !isVideo) return { skipped: "kind" };

    const original = await storage.get(file.storageKey);
    const source = isVideo ? await videoFrame(original) : original;
    if (!source) return { skipped: "no frame" };

    // Phone photos carry their rotation in EXIF: apply it, then measure.
    const meta = await sharp(source, { animated: false }).rotate().metadata();
    const width = meta.autoOrient?.width ?? meta.width ?? null;
    const height = meta.autoOrient?.height ?? meta.height ?? null;
    if (isImage && file.sizeBytes <= SMALL_BYTES && (width ?? 0) <= WIDTH) {
      await db.update(f).set({ width, height }).where(eq(f.id, file.id));
      return { skipped: "small" };
    }
    const preview = await sharp(source, { animated: false })
      .rotate()
      .resize({ width: WIDTH, withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();
    const key = `previews/${file.organizationId}/${file.sha256}.webp`;
    await storage.put(key, new Uint8Array(preview), { contentType: "image/webp" });
    await db.update(f).set({ previewKey: key, width, height }).where(eq(f.id, file.id));
    return { bytes: preview.byteLength, of: file.sizeBytes };
  };
}
