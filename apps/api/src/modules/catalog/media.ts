import { fileStorage, newId } from "@relay/core";
import { catalogMediaKind, catalogMediaLimits } from "@relay/core/catalog";
import {
  and,
  asc,
  deleteFileIfUnused,
  eq,
  isNull,
  releaseStorage,
  reserveStorage,
  schema,
  sql,
} from "@relay/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { enqueue } from "../../lib/enqueue";
import { can, fail } from "../branches/access";
import { parseBody } from "../branches/routes";
import type { BranchEnv } from "../contacts/shared";

/*
 * An item's gallery (mounted at /api/catalog/media, behind the catalogue's branch check):
 *   POST   /upload-url        { itemId, fileName, mimeType, sizeBytes } → a media row and a link the
 *                             browser PUTs the file to (null on local storage: POST /:id/upload instead)
 *   POST   /:id/upload        the file itself, multipart, only when there's no direct link (≤ 50 MB)
 *   POST   /:id/complete      the upload is done: prepare it for WhatsApp
 *   PATCH  /:id               { caption?, isPrimary? }
 *   POST   /reorder           { itemId, ids } in the new order
 *   DELETE /:id
 *   GET    /:id/file          the file (?preview=1 for the small preview)
 * The upload's size is held against the business's storage from the start, so a full business is told
 * before it uploads, and two big uploads at once can't both pass the limit.
 */

const LOCAL_MAX = 50 * 1024 * 1024;

export function catalogMediaRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  const M = schema.catalogMedia;
  const I = schema.catalogItem;
  const storage = fileStorage();

  const canManage = async (c: Context<BranchEnv>) =>
    can(c.var.access, "catalogue.manage", { branchId: c.var.branchId });
  const mediaIn = (c: Context<BranchEnv>, id: string) =>
    and(eq(M.id, id), eq(M.organizationId, c.var.access.orgId), eq(M.branchId, c.var.branchId));
  const prepare = (mediaId: string) =>
    enqueue(
      ctx.queues.catalogMedia,
      "prepare",
      { mediaId },
      { jobId: mediaId, attempts: 2, backoff: { type: "exponential", delay: 10_000 } },
    );
  /** A gallery change makes the item searchable "with a photo" again. */
  const touchItem = (itemId: string) =>
    ctx.db.update(I).set({ updatedAt: new Date() }).where(eq(I.id, itemId));

  app.post("/upload-url", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({
        itemId: z.string(),
        variantId: z.string().nullable().optional(),
        fileName: z.string().trim().min(1).max(200),
        mimeType: z.string().trim().min(3).max(100),
        sizeBytes: z.number().int().min(1),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    const kind = catalogMediaKind(b.mimeType);
    if (!kind) return fail(c, 415, "unsupported_file", "Use a photo, a video, an audio recording or a PDF.");
    const max = catalogMediaLimits.uploadMaxBytes[kind];
    if (b.sizeBytes > max)
      return fail(
        c,
        413,
        "file_too_large",
        `${kind[0]?.toUpperCase()}${kind.slice(1)}s can be up to ${Math.round(max / 1024 ** 2)} MB.`,
      );
    const orgId = c.var.access.orgId;
    const [item] = await ctx.db
      .select({ id: I.id })
      .from(I)
      .where(and(eq(I.id, b.itemId), eq(I.organizationId, orgId), eq(I.branchId, c.var.branchId)));
    if (!item) return fail(c, 404, "not_found", "That item isn't in this branch.");
    const [{ n, next, primaries } = { n: 0, next: 0, primaries: 0 }] = await ctx.db
      .select({
        n: sql<number>`count(*)::int`,
        next: sql<number>`coalesce(max(${M.position}), -1)::int + 1`,
        primaries: sql<number>`count(*) filter (where ${M.isPrimary} and ${M.variantId} is null)::int`,
      })
      .from(M)
      .where(eq(M.itemId, item.id));
    if (n >= catalogMediaLimits.filesPerItem)
      return fail(
        c,
        422,
        "too_many_files",
        `An item can have up to ${catalogMediaLimits.filesPerItem} photos and videos.`,
      );
    // Hold the space now (throws storage_full, answered as 413 by the app).
    await reserveStorage(ctx.db, orgId, b.sizeBytes, "enforce");
    const id = newId("catalogMedia");
    const uploadKey = `uploads/${orgId}/${id}`;
    try {
      const [media] = await ctx.db
        .insert(M)
        .values({
          id,
          organizationId: orgId,
          branchId: c.var.branchId,
          itemId: item.id,
          variantId: b.variantId ?? null,
          kind,
          mimeType: b.mimeType,
          fileName: b.fileName,
          sizeBytes: b.sizeBytes,
          reservedBytes: b.sizeBytes,
          uploadKey,
          position: next,
          // The first item-wide photo or video becomes the primary.
          isPrimary: !b.variantId && primaries === 0 && (kind === "image" || kind === "video"),
        })
        .returning();
      const uploadUrl = await storage.signedUploadUrl(uploadKey, { contentType: b.mimeType });
      return c.json({ media, uploadUrl }, 201);
    } catch (err) {
      await releaseStorage(ctx.db, orgId, b.sizeBytes);
      throw err;
    }
  });

  app.post("/:id/upload", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [media] = await ctx.db
      .select()
      .from(M)
      .where(mediaIn(c, c.req.param("id")));
    if (!media?.uploadKey || media.status !== "processing") return fail(c, 404, "not_found");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return fail(c, 422, "file_required", "Choose a file.");
    if (file.size > LOCAL_MAX || file.size > media.reservedBytes + 1024)
      return fail(c, 413, "file_too_large", "That file is bigger than the one you started uploading.");
    await storage.put(media.uploadKey, new Uint8Array(await file.arrayBuffer()), {
      contentType: media.mimeType,
    });
    await prepare(media.id);
    return c.json({ ok: true });
  });

  app.post("/:id/complete", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [media] = await ctx.db
      .select()
      .from(M)
      .where(mediaIn(c, c.req.param("id")));
    if (!media) return fail(c, 404, "not_found");
    if (media.status === "processing") await prepare(media.id);
    return c.json({ media });
  });

  app.patch("/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({
        caption: z.string().trim().max(300).nullable().optional(),
        isPrimary: z.literal(true).optional(),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const [media] = await ctx.db
      .select()
      .from(M)
      .where(mediaIn(c, c.req.param("id")));
    if (!media) return fail(c, 404, "not_found");
    if (parsed.data.isPrimary) {
      if (media.variantId || (media.kind !== "image" && media.kind !== "video"))
        return fail(c, 422, "not_primary", "Only an item-wide photo or video can be the main one.");
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(M)
          .set({ isPrimary: false })
          .where(and(eq(M.itemId, media.itemId), eq(M.isPrimary, true), isNull(M.variantId)));
        await tx.update(M).set({ isPrimary: true, updatedAt: new Date() }).where(eq(M.id, media.id));
      });
    }
    if (parsed.data.caption !== undefined)
      await ctx.db
        .update(M)
        .set({ caption: parsed.data.caption || null, updatedAt: new Date() })
        .where(eq(M.id, media.id));
    await touchItem(media.itemId);
    return c.json({ ok: true });
  });

  app.post("/reorder", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({ itemId: z.string(), ids: z.array(z.string()).min(1).max(100) }),
    );
    if ("error" in parsed) return parsed.error;
    const rows = await ctx.db
      .select({ id: M.id })
      .from(M)
      .where(
        and(
          eq(M.itemId, parsed.data.itemId),
          eq(M.organizationId, c.var.access.orgId),
          eq(M.branchId, c.var.branchId),
        ),
      );
    const mine = new Set(rows.map((r) => r.id));
    if (parsed.data.ids.some((id) => !mine.has(id)))
      return fail(c, 422, "bad_order", "That order doesn't match the gallery.");
    await ctx.db.transaction(async (tx) => {
      for (const [i, id] of parsed.data.ids.entries())
        await tx.update(M).set({ position: i }).where(eq(M.id, id));
    });
    await touchItem(parsed.data.itemId);
    return c.json({ ok: true });
  });

  app.delete("/:id", async (c) => {
    if (!(await canManage(c))) return fail(c, 403, "forbidden");
    const [media] = await ctx.db
      .delete(M)
      .where(mediaIn(c, c.req.param("id")))
      .returning();
    if (!media) return fail(c, 404, "not_found");
    const orgId = c.var.access.orgId;
    if (media.reservedBytes) await releaseStorage(ctx.db, orgId, media.reservedBytes);
    if (media.uploadKey) await storage.delete(media.uploadKey).catch(() => {});
    if (media.fileId) await deleteFileIfUnused(ctx.db, storage, orgId, media.fileId);
    // The main photo went: the next photo or video takes its place.
    if (media.isPrimary) {
      const [next] = await ctx.db
        .select({ id: M.id })
        .from(M)
        .where(and(eq(M.itemId, media.itemId), isNull(M.variantId), sql`${M.kind} in ('image','video')`))
        .orderBy(asc(M.position))
        .limit(1);
      if (next) await ctx.db.update(M).set({ isPrimary: true }).where(eq(M.id, next.id));
    }
    await touchItem(media.itemId);
    return c.body(null, 204);
  });

  app.get("/:id/file", async (c) => {
    const [row] = await ctx.db
      .select({ media: M, file: schema.storedFile })
      .from(M)
      .innerJoin(schema.storedFile, eq(schema.storedFile.id, M.fileId))
      .where(mediaIn(c, c.req.param("id")));
    if (!row) return fail(c, 404, "not_found");
    const preview = c.req.query("preview") === "1" && row.file.previewKey;
    const key = preview ? (row.file.previewKey as string) : row.file.storageKey;
    const contentType = preview ? "image/webp" : (row.file.mimeType ?? "application/octet-stream");
    const url = await storage.signedUrl(key, {
      expiresIn: 3600,
      contentType,
      fileName: row.media.fileName,
      inline: true,
    });
    if (url) {
      c.header("Cache-Control", "private, max-age=3000");
      return c.redirect(url, 302);
    }
    const bytes = await storage.get(key);
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    });
  });

  return app;
}
