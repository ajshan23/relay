import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { localFileStorage, newId } from "@relay/core";
import {
  createCatalogType,
  createDb,
  eq,
  getStorageUsage,
  reserveStorage,
  saveCatalogItem,
  schema,
} from "@relay/db";
import sharp from "sharp";
import { createCatalogMediaProcessor } from "../src/catalog/media";

/*
 * Catalogue gallery files on the local drill database and a temporary local storage folder: a big PNG
 * becomes a JPEG under 5 MB, a MOV becomes an H.264 MP4, a WAV becomes an MP3, a PDF stays, an
 * unusable file fails with a reason, and the space held for each upload becomes the real size.
 * Needs ffmpeg/ffprobe (as the server does).
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const T = Date.now().toString(36);
const org = `org_m${T}`;
const branch = `br_m${T}`;
const dir = mkdtempSync(join(tmpdir(), "relay-media-test-"));
const storage = localFileStorage(dir);
const prepare = createCatalogMediaProcessor({ db, storage });
let itemId = "";

async function upload(kind: "image" | "video" | "audio" | "document", mimeType: string, bytes: Uint8Array) {
  const id = newId("catalogMedia");
  const uploadKey = `uploads/${org}/${id}`;
  await reserveStorage(db, org, bytes.byteLength, "enforce");
  await storage.put(uploadKey, bytes);
  await db.insert(schema.catalogMedia).values({
    id,
    organizationId: org,
    branchId: branch,
    itemId,
    kind,
    mimeType,
    fileName: `file.${mimeType.split("/")[1]}`,
    sizeBytes: bytes.byteLength,
    reservedBytes: bytes.byteLength,
    uploadKey,
  });
  await prepare({ data: { mediaId: id }, attemptsMade: 0, opts: { attempts: 1 } } as never);
  const [row] = await db.select().from(schema.catalogMedia).where(eq(schema.catalogMedia.id, id));
  if (!row) throw new Error("media row gone");
  return { row, uploadKey };
}

const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: org, name: "M test", slug: `m-${T}`, createdAt: new Date() });
  await db
    .insert(schema.branch)
    .values({ id: branch, organizationId: org, name: "Marina", slug: "marina" } as never);
  const type = await createCatalogType(db, {
    organizationId: org,
    name: "Product",
    kind: "product",
    template: "product",
    newId: (k) => newId(k),
  });
  const item = await saveCatalogItem(db, {
    organizationId: org,
    branchId: branch,
    userId: null,
    input: {
      typeId: type.id,
      title: "Sofa Oslo",
      description: "",
      attributes: {},
      status: "active",
      tags: [],
      variants: [{ title: "", price: 1999, currency: "AED", options: {}, available: true, bookable: false }],
    },
    newId: (k) => newId(k),
  });
  itemId = item.id;
});
after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, org));
  await pg.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("catalogue media", () => {
  it("turns a big PNG into a JPEG under 5 MB and counts only the result", async () => {
    const png = await sharp(
      Buffer.from(Array.from({ length: 2400 * 2400 * 3 }, () => Math.floor(Math.random() * 256))),
      {
        raw: { width: 2400, height: 2400, channels: 3 },
      },
    )
      .png({ compressionLevel: 0 })
      .toBuffer();
    assert.ok(png.byteLength > 5 * 1024 * 1024, "the fixture is over WhatsApp's limit");
    const { row, uploadKey } = await upload("image", "image/png", new Uint8Array(png));
    assert.equal(row.status, "ready", row.error ?? "");
    assert.equal(row.mimeType, "image/jpeg");
    assert.ok((row.sizeBytes ?? 0) <= 5 * 1024 * 1024);
    assert.ok((row.width ?? 0) <= 2048);
    assert.equal(row.reservedBytes, 0);
    assert.equal(await storage.exists(uploadKey), false, "the upload is cleaned up");
    assert.equal((await getStorageUsage(db, org)).usedBytes, row.sizeBytes, "only the prepared file counts");
  });

  it("converts a MOV to an H.264 MP4 WhatsApp plays", async () => {
    const mov = join(dir, "clip.mov");
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=3:size=1920x1080:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=3",
      "-c:v",
      "mpeg4",
      "-c:a",
      "pcm_s16le",
      mov,
    ]);
    const { row } = await upload("video", "video/quicktime", new Uint8Array(readFileSync(mov)));
    assert.equal(row.status, "ready", row.error ?? "");
    assert.equal(row.mimeType, "video/mp4");
    assert.ok((row.sizeBytes ?? 0) <= 16 * 1024 * 1024);
    assert.ok((row.width ?? 0) <= 1280 && (row.height ?? 0) <= 1280);
    assert.equal(row.durationSeconds, 3);
    const out = join(dir, "out-check.mp4");
    const [file] = await db
      .select()
      .from(schema.storedFile)
      .where(eq(schema.storedFile.id, row.fileId ?? ""));
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(out, readFileSync(join(dir, file?.storageKey ?? ""))),
    );
    const codec = execFileSync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
      out,
    ])
      .toString()
      .trim();
    assert.equal(codec, "h264");
  });

  it("turns a WAV into an MP3, keeps a PDF, and refuses what can't be sent", async () => {
    const wav = join(dir, "note.wav");
    ff(["-f", "lavfi", "-i", "sine=duration=2", wav]);
    const audio = await upload("audio", "audio/wav", new Uint8Array(readFileSync(wav)));
    assert.equal(audio.row.status, "ready", audio.row.error ?? "");
    assert.equal(audio.row.mimeType, "audio/mpeg");

    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    const doc = await upload("document", "application/pdf", pdf);
    assert.equal(doc.row.status, "ready");
    assert.equal(doc.row.mimeType, "application/pdf");

    const before = (await getStorageUsage(db, org)).usedBytes;
    const bad = await upload("video", "video/mp4", new TextEncoder().encode("not a video at all"));
    assert.equal(bad.row.status, "failed");
    assert.match(bad.row.error ?? "", /couldn't be prepared|no video/);
    assert.equal((await getStorageUsage(db, org)).usedBytes, before, "a failed file gives its space back");
  });
});
