import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

/*
 * Where Relay keeps files: customer media, team uploads, template header files, contact imports and
 * exports. On servers (and in development, with a dev bucket) that's S3; without S3_BUCKET it's the
 * local disk folder MEDIA_DIR (tests and offline work). Callers use fileStorage() and never care which.
 *
 * Keys, the same on both. The kind comes first, so S3 lifecycle rules (which match fixed prefixes
 * only) can treat each kind differently:
 *   files/<org>/<sha256>          every stored file, once per business (see @relay/db files.ts)
 *   imports/<org>/<id>.<ext>      uploaded spreadsheets (S3 deletes them after 30 days)
 *   exports/<org>/<id>.<ext>      exports (S3 deletes them after a day)
 */

export type FileStorage = {
  /** "s3" or "local", for logs and for choosing between a redirect and streaming. */
  readonly driver: "s3" | "local";
  put(key: string, bytes: Uint8Array, opts?: { contentType?: string | null }): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /**
   * A short-lived link the browser downloads from directly, so the API never carries the bytes. Null
   * on local disk: the caller streams the file instead.
   */
  signedUrl(
    key: string,
    opts: { expiresIn?: number; fileName?: string | null; contentType?: string | null; inline?: boolean },
  ): Promise<string | null>;
};

/** The repository root, so relative paths mean the same thing for the API, the worker and scripts. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function localFileStorage(dir: string): FileStorage {
  const base = isAbsolute(dir) ? dir : join(repoRoot, dir);
  const pathFor = (key: string) => {
    const full = normalize(join(base, key));
    if (!full.startsWith(base)) throw new Error("Invalid storage key");
    return full;
  };
  return {
    driver: "local",
    async put(key, bytes) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    async get(key) {
      return new Uint8Array(await readFile(pathFor(key)));
    },
    async exists(key) {
      return stat(pathFor(key)).then(
        () => true,
        () => false,
      );
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
    async signedUrl() {
      return null;
    },
  };
}

/** A header-safe file name for Content-Disposition (ASCII fallback plus the UTF-8 original). */
function disposition(inline: boolean, fileName?: string | null) {
  const kind = inline ? "inline" : "attachment";
  if (!fileName) return kind;
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function s3FileStorage(opts: { bucket: string; region: string }): FileStorage {
  // Credentials come from the standard AWS chain: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY locally,
  // the instance or task role on servers.
  const client = new S3Client({ region: opts.region });
  const Bucket = opts.bucket;
  return {
    driver: "s3",
    async put(key, bytes, o) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: bytes,
          ContentType: o?.contentType ?? undefined,
          ServerSideEncryption: "AES256",
          // S3 checks the bytes it received against this.
          ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
        }),
      );
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!res.Body) throw new Error(`Empty object ${key}`);
      return new Uint8Array(await res.Body.transformToByteArray());
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return true;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || status === 403) return false;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async signedUrl(key, o) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentType: o.contentType ?? undefined,
          ResponseContentDisposition: disposition(o.inline ?? false, o.fileName),
          ResponseCacheControl: "private, max-age=86400",
        }),
        { expiresIn: o.expiresIn ?? 300 },
      );
    },
  };
}

let shared: FileStorage | undefined;

/** The storage this process uses: S3 when S3_BUCKET is set (or STORAGE_DRIVER=s3), else local disk. */
export function fileStorage(): FileStorage {
  if (!shared) {
    const config = env();
    const useS3 = config.STORAGE_DRIVER ? config.STORAGE_DRIVER === "s3" : !!config.S3_BUCKET;
    if (useS3 && !config.S3_BUCKET) throw new Error("STORAGE_DRIVER=s3 needs S3_BUCKET");
    shared =
      useS3 && config.S3_BUCKET
        ? s3FileStorage({ bucket: config.S3_BUCKET, region: config.S3_REGION })
        : localFileStorage(config.MEDIA_DIR);
  }
  return shared;
}
