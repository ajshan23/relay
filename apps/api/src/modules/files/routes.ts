import { createHash } from "node:crypto";
import { fileStorage, newId } from "@relay/core";
import { and, eq, schema, sql, storeFile } from "@relay/db";
import { Hono } from "hono";
import sharp from "sharp";
import { channels } from "../../channels";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, fail, requireOrg } from "../branches/access";
import { canWork, findConversation } from "../conversations/access";

/*
 * Files in conversations.
 *   POST /api/uploads              a teammate's file, checked against the conversation's channel limits,
 *                                  then sent with POST /api/conversations/:id/messages { uploadId }
 *   GET  /api/attachments/:id      any stored file the caller may see (customer media and uploads)
 */

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
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024) || 1} MB`;

export function fileRoutes(ctx: AppContext) {
  const storage = fileStorage();
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  app.post("/uploads", async (c) => {
    const access = c.var.access;
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    const conversationId = form?.get("conversationId");
    // A template header picture or file is uploaded before any conversation: check it against the
    // business's channels that have templates.
    const forTemplate = form?.get("use") === "template";
    if (!(file instanceof File) || (!forTemplate && typeof conversationId !== "string"))
      return fail(c, 422, "invalid_input", "Send a file and the conversation it is for.");
    let accountType: string | null = null;
    if (forTemplate) {
      const accounts = await ctx.db
        .select({ type: schema.channelAccount.type })
        .from(schema.channelAccount)
        .where(eq(schema.channelAccount.organizationId, access.orgId));
      accountType = accounts.find((a) => channels().get(a.type)?.capabilities.templates)?.type ?? null;
    } else {
      const conversation = await findConversation(ctx, access, String(conversationId));
      if (!conversation) return fail(c, 404, "not_found");
      if (!(await canWork(ctx, access, conversation))) return fail(c, 403, "forbidden");
      const [account] = await ctx.db
        .select({ type: schema.channelAccount.type })
        .from(schema.channelAccount)
        .where(eq(schema.channelAccount.id, conversation.channelAccountId))
        .limit(1);
      accountType = account?.type ?? null;
    }
    const caps = accountType ? channels().get(accountType as never)?.capabilities : null;
    if (!caps) return fail(c, 409, "unsupported_channel", "Files can't be sent on this channel yet.");

    const mimeType = (file.type || "application/octet-stream").split(";")[0]?.trim() ?? "";
    // Stickers are only sent as stickers on purpose, never because a .webp was attached.
    const kind = (["image", "video", "audio", "document"] as const).find((k) =>
      caps.media[k].mimeTypes.includes(mimeType),
    );
    if (!kind)
      return fail(
        c,
        415,
        "unsupported_file",
        "This channel can't send that kind of file. Images must be JPG or PNG; documents PDF, Word, Excel, PowerPoint or text.",
      );
    if (file.size === 0) return fail(c, 422, "empty_file", "The file is empty.");
    // Photos may be over the channel's limit before shrinking, up to 25 MB; nothing else may.
    const limit = caps.media[kind].maxBytes;
    const accept = kind === "image" ? Math.max(limit, 25 * 1024 * 1024) : limit;
    if (file.size > accept)
      return fail(
        c,
        413,
        "file_too_large",
        `${kind[0]?.toUpperCase()}${kind.slice(1)}s can be up to ${mb(limit)}.`,
      );
    // Big phone photos are resized before storing (see shrinkPhoto); the limit applies afterwards.
    let bytes = new Uint8Array(await file.arrayBuffer());
    let storedMime = mimeType;
    let fileName = file.name.slice(0, 200);
    if (kind === "image") {
      const small = await shrinkPhoto(bytes, mimeType).catch(() => null);
      if (small) {
        bytes = small.bytes;
        storedMime = small.mimeType;
        if (small.mimeType !== mimeType) fileName = fileName.replace(/\.[^.]*$/, "") + ".jpg";
      }
    }
    if (bytes.byteLength > limit)
      return fail(
        c,
        413,
        "file_too_large",
        `${kind[0]?.toUpperCase()}${kind.slice(1)}s can be up to ${mb(limit)}.`,
      );
    const id = newId("attachment");
    const extension = extensions[storedMime] ?? fileName.split(".").pop()?.toLowerCase() ?? "bin";
    // Stored once per business: the same file uploaded again (or sent in a broadcast) reuses it.
    const { file: stored } = await storeFile(ctx.db, storage, {
      organizationId: access.orgId,
      bytes,
      mimeType: storedMime,
      newId: () => newId("storedFile"),
    });
    // A small preview for the chat (the worker makes it).
    if ((kind === "image" || kind === "video") && !stored.previewKey)
      await ctx.queues.previews
        .add("preview", { fileId: stored.id }, { jobId: `preview_${stored.id}`, attempts: 2 })
        .catch((err) => console.warn("preview job", err));
    const [row] = await ctx.db
      .insert(schema.attachment)
      .values({
        id,
        organizationId: access.orgId,
        uploadedByUserId: access.userId,
        kind,
        mimeType: storedMime,
        fileName: fileName || `${id}.${extension}`,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("base64"),
        fileId: stored.id,
        storageKey: stored.storageKey,
        status: "stored",
      })
      .returning();
    if (!row) return fail(c, 500, "internal_error");
    return c.json(
      {
        upload: {
          id: row.id,
          kind: row.kind,
          mimeType: row.mimeType,
          fileName: row.fileName,
          sizeBytes: row.sizeBytes,
          url: `/api/attachments/${row.id}`,
        },
      },
      201,
    );
  });

  app.get("/attachments/:id", async (c) => {
    const access = c.var.access;
    const [file] = await ctx.db
      .select()
      .from(schema.attachment)
      .where(
        and(eq(schema.attachment.id, c.req.param("id")), eq(schema.attachment.organizationId, access.orgId)),
      )
      .limit(1);
    if (!file) return fail(c, 404, "not_found");
    if (file.messageId) {
      const [message] = await ctx.db
        .select({ conversationId: schema.message.conversationId })
        .from(schema.message)
        .where(eq(schema.message.id, file.messageId))
        .limit(1);
      if (!message || !(await findConversation(ctx, access, message.conversationId)))
        return fail(c, 404, "not_found");
    } else if (file.uploadedByUserId !== access.userId) {
      // An unsent upload is only its uploader's, unless it is a template's header file.
      const [usedBy] = await ctx.db
        .select({ id: schema.messageTemplate.id })
        .from(schema.messageTemplate)
        .where(
          and(
            eq(schema.messageTemplate.organizationId, access.orgId),
            sql`${schema.messageTemplate.content}->'header'->>'attachmentId' = ${file.id}`,
          ),
        )
        .limit(1);
      if (!usedBy) return fail(c, 404, "not_found");
    }
    if (file.status === "pending") return fail(c, 409, "not_ready", "The file is still being downloaded.");
    if (file.status === "failed" || !file.storageKey)
      return fail(c, 410, "unavailable", file.error ?? "The file could not be downloaded from the channel.");
    // ?preview=1: the small chat preview when there is one (else the file itself).
    let key = file.storageKey;
    let contentType = file.mimeType;
    if (c.req.query("preview") && file.fileId) {
      const [stored] = await ctx.db
        .select({ previewKey: schema.storedFile.previewKey })
        .from(schema.storedFile)
        .where(eq(schema.storedFile.id, file.fileId))
        .limit(1);
      if (stored?.previewKey) {
        key = stored.previewKey;
        contentType = "image/webp";
      }
    }
    const name = (file.fileName ?? file.id).replace(/["\r\n]/g, "");
    const inline = /^(image|video|audio)\//.test(file.mimeType ?? "") || file.mimeType === "application/pdf";
    // On S3 the browser fetches the bytes straight from the bucket with a 5-minute link.
    const url = await storage.signedUrl(key, {
      expiresIn: 300,
      fileName: name,
      contentType,
      inline: inline || key !== file.storageKey,
    });
    if (url) return c.redirect(url, 302);
    const bytes = await storage.get(key);
    return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
      "content-type": contentType ?? "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    });
  });

  return app;
}

/** Longest side a stored photo keeps; WhatsApp delivers photos smaller than this anyway. */
const MAX_SIDE = 2048;

/**
 * Shrinks a big photo a teammate uploads (phones send 3–8 MB at 4000+ px): at most 2048 px on the
 * longest side, JPEG quality 85, rotation applied. No visible difference in a chat, 5–10× smaller.
 * PNGs with transparency stay PNG. Returns null when the photo is already small enough.
 */
async function shrinkPhoto(bytes: Uint8Array, mimeType: string) {
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") return null;
  const image = sharp(bytes, { failOn: "error" });
  const meta = await image.metadata();
  const w = meta.autoOrient?.width ?? meta.width ?? 0;
  const h = meta.autoOrient?.height ?? meta.height ?? 0;
  if (Math.max(w, h) <= MAX_SIDE && bytes.byteLength <= 1.5 * 1024 * 1024) return null;
  const resized = image
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
  const keepPng = mimeType === "image/png" && meta.hasAlpha;
  const out = keepPng
    ? await resized.png({ compressionLevel: 9, palette: true }).toBuffer()
    : await resized.flatten({ background: "#ffffff" }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  // Never store a "smaller" version that came out bigger.
  if (out.byteLength >= bytes.byteLength) return null;
  return { bytes: new Uint8Array(out), mimeType: keepPng ? "image/png" : "image/jpeg" };
}
