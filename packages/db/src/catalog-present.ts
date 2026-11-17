import { newId } from "@relay/core";
import { optionOfReply, optionReplyId } from "@relay/core/automations";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type CatalogCard, catalogCards } from "./catalog";
import type { createDb } from "./client";
import * as schema from "./schema/index";

/*
 * How catalogue items look on WhatsApp, for the AI agent and the team's "Send item":
 *   1 item         its main photo or video on top of reply buttons (More details, Order / Book)
 *   2–10 items     a carousel of cards when every item has a photo or video; otherwise a list (tap a
 *                  row to get that item's card)
 *   More details   the item's whole gallery: photos and videos as carousels (10 per message), a lone
 *                  one as a media message, then audio and PDFs, with the item's details on top
 * Every message keeps `items` (id, name, price) so a tap can be traced to its item and the agent's
 * history says what was shown. Button ids: optionReplyId(message step key, "i<n><action>").
 */

type Db = ReturnType<typeof createDb>["db"];

export type Sent = { ok: true; messageId: string } | { ok: false; reason: string };
/** Sends one message (idempotent by its step key); the caller adds who it is from. */
export type SendFn = (
  key: string,
  type: string,
  content: Record<string, unknown>,
  attachmentId?: string,
) => Promise<Sent>;

export type CardAction = "order" | "book" | "none";
/** What a tap on one of our item buttons asks for. */
export type ItemTap = { itemId: string; action: "more" | "order" | "book" | "select"; title: string };

const actionCode = { more: "m", order: "o", book: "b", select: "s" } as const;
const actionOf = Object.fromEntries(Object.entries(actionCode).map(([k, v]) => [v, k])) as Record<
  string,
  ItemTap["action"]
>;
const label = { more: "More details", order: "Order", book: "Book" } as const;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createCatalogPresenter(deps: { db: Db }) {
  const { db } = deps;
  const M = schema.catalogMedia;

  /** A message attachment for a stored file (header pictures and gallery files go out as attachments). */
  async function attach(organizationId: string, fileId: string, kind: string, fileName?: string | null) {
    const [file] = await db
      .select()
      .from(schema.storedFile)
      .where(and(eq(schema.storedFile.id, fileId), eq(schema.storedFile.organizationId, organizationId)))
      .limit(1);
    if (!file) return null;
    const id = newId("attachment");
    await db.insert(schema.attachment).values({
      id,
      organizationId,
      kind: kind as "image",
      mimeType: file.mimeType ?? "application/octet-stream",
      fileName: fileName ?? null,
      sizeBytes: file.sizeBytes,
      sha256: Buffer.from(file.sha256, "hex").toString("base64"),
      fileId: file.id,
      storageKey: file.storageKey,
      status: "stored",
    });
    return { attachmentId: id, file };
  }

  async function primaries(itemIds: string[]) {
    if (!itemIds.length) return new Map<string, { mediaId: string; fileId: string; kind: "image" | "video" }>();
    const rows = await db
      .select({ id: M.id, itemId: M.itemId, fileId: M.fileId, kind: M.kind })
      .from(M)
      .where(
        and(
          inArray(M.itemId, itemIds),
          eq(M.isPrimary, true),
          eq(M.status, "ready"),
          sql`${M.variantId} is null`,
        ),
      );
    return new Map(
      rows
        .filter(
          (r): r is { id: string; itemId: string; fileId: string; kind: "image" | "video" } =>
            !!r.fileId && (r.kind === "image" || r.kind === "video"),
        )
        .map((r) => [r.itemId, { mediaId: r.id, fileId: r.fileId, kind: r.kind }]),
    );
  }

  const shownItems = (cards: CatalogCard[]) =>
    cards.map((c) => ({ id: c.id, title: c.title, priceText: c.priceText }));
  const cardText = (c: CatalogCard) => [c.title, c.priceText ?? "Price on request"].join("\n");
  const buttonsFor = (stepKey: string, n: number, action: CardAction) =>
    (["more", ...(action === "none" ? [] : [action])] as ("more" | "order" | "book")[]).map((a) => ({
      id: optionReplyId(stepKey, `i${n}${actionCode[a]}`),
      title: label[a],
    }));

  /** One item as a card: main photo on top, name, price, a line of detail, and the buttons. */
  async function sendCard(
    org: { organizationId: string; branchId: string },
    send: SendFn,
    stepKey: string,
    card: CatalogCard,
    action: CardAction,
    text?: string,
  ) {
    const primary = (await primaries([card.id])).get(card.id);
    const header = primary ? await attach(org.organizationId, primary.fileId, primary.kind) : null;
    const detail = [card.details.slice(0, 3).join(" · "), card.description].filter(Boolean).join("\n");
    const body = cut(
      [text, `*${card.title}*`, card.priceText ?? "Price on request", detail].filter(Boolean).join("\n"),
      1024,
    );
    return send(stepKey, "interactive", {
      type: "interactive",
      kind: "buttons",
      body,
      options: buttonsFor(stepKey, 0, action),
      ...(header ? { header: { kind: primary?.kind, attachmentId: header.attachmentId } } : {}),
      items: shownItems([card]),
    });
  }

  /** Shows 1–10 items in the best format their media allow. */
  async function showItems(args: {
    organizationId: string;
    branchId: string;
    send: SendFn;
    stepKey: string;
    itemIds: string[];
    action: CardAction;
    text?: string;
  }): Promise<Sent> {
    const cards = (
      await catalogCards(db, {
        organizationId: args.organizationId,
        branchId: args.branchId,
        ids: args.itemIds.slice(0, 10),
        descriptionChars: 200,
      })
    ).filter((c) => c.variants.length);
    if (!cards.length)
      return args.send(args.stepKey, "text", {
        type: "text",
        text: "Sorry, I couldn't find that item any more.",
      });
    const first = cards[0] as CatalogCard;
    if (cards.length === 1) return sendCard(args, args.send, args.stepKey, first, args.action, args.text);
    const media = await primaries(cards.map((c) => c.id));
    if (cards.every((c) => media.has(c.id)))
      return args.send(args.stepKey, "interactive", {
        type: "interactive",
        kind: "carousel",
        body: cut(args.text || "Here's what I found:", 1024),
        cards: cards.map((c, n) => ({
          fileId: media.get(c.id)?.fileId,
          mediaId: media.get(c.id)?.mediaId,
          mediaKind: media.get(c.id)?.kind,
          body: cut(cardText(c), 160),
          buttons: buttonsFor(args.stepKey, n, args.action),
        })),
        items: shownItems(cards),
      });
    return args.send(args.stepKey, "interactive", {
      type: "interactive",
      kind: "list",
      body: cut(args.text || "Here's what I found. Tap one to see it:", 1024),
      buttonText: "See items",
      options: cards.map((c, n) => ({
        id: optionReplyId(args.stepKey, `i${n}s`),
        title: cut(c.title, 24),
        description: cut([c.priceText ?? "Price on request", c.details[0]].filter(Boolean).join(" · "), 72),
      })),
      items: shownItems(cards),
    });
  }

  /** One item's whole gallery, with its details on top. */
  async function showGallery(args: {
    organizationId: string;
    branchId: string;
    send: SendFn;
    stepKey: string;
    itemId: string;
    text?: string;
  }): Promise<Sent> {
    const [card] = await catalogCards(db, {
      organizationId: args.organizationId,
      branchId: args.branchId,
      ids: [args.itemId],
      descriptionChars: 600,
    });
    if (!card)
      return args.send(args.stepKey, "text", {
        type: "text",
        text: "Sorry, I couldn't find that item any more.",
      });
    const files = await db
      .select()
      .from(M)
      .where(and(eq(M.itemId, card.id), eq(M.status, "ready"), sql`${M.fileId} is not null`))
      .orderBy(asc(M.position));
    const [type] = await db
      .select({ kind: schema.catalogType.kind })
      .from(schema.catalogType)
      .innerJoin(schema.catalogItem, eq(schema.catalogItem.typeId, schema.catalogType.id))
      .where(eq(schema.catalogItem.id, card.id));
    const action: CardAction = type?.kind === "service" ? "book" : "order";
    const details = cut(
      [
        args.text,
        `*${card.title}*`,
        card.priceText ?? "Price on request",
        card.details.join(" · "),
        card.variants.length > 1
          ? `Options: ${card.variants.map((v) => `${v.title || "Standard"}${(v.salePrice ?? v.price) ? ` (${(v.salePrice ?? v.price)?.text})` : ""}${v.available ? "" : ", sold out"}`).join("; ")}`
          : "",
        card.description,
      ]
        .filter(Boolean)
        .join("\n"),
      1024,
    );
    const visuals = files.filter((f) => f.kind === "image" || f.kind === "video");
    const others = files.filter((f) => f.kind === "audio" || f.kind === "document");
    let last: Sent = { ok: false, reason: "nothing_sent" };
    let part = 0;
    const key = () => (part++ === 0 ? args.stepKey : `${args.stepKey}:g${part - 1}`);
    // Photos, then videos; mixing them in one carousel isn't documented as allowed.
    const groups = [
      visuals.filter((f) => f.kind === "image"),
      visuals.filter((f) => f.kind === "video"),
    ].flatMap((g) => {
      const out: (typeof g)[] = [];
      for (let i = 0; i < g.length; i += 10) out.push(g.slice(i, i + 10));
      return out;
    });
    let detailsSent = false;
    for (const group of groups) {
      if (group.length >= 2) {
        const k = key();
        last = await args.send(k, "interactive", {
          type: "interactive",
          kind: "carousel",
          body: detailsSent ? `More of ${card.title}` : details,
          cards: group.map((f, n) => ({
            fileId: f.fileId,
            mediaId: f.id,
            mediaKind: f.kind,
            body: cut(f.caption || `${card.title} ${n + 1}/${group.length}`, 160),
            buttons: [{ id: optionReplyId(k, `i0${actionCode[action]}`), title: label[action] }],
          })),
          items: shownItems([card]),
        });
        detailsSent = true;
      } else if (group[0]) {
        const f = group[0];
        const a = await attach(args.organizationId, f.fileId as string, f.kind, f.fileName);
        if (!a) continue;
        last = await args.send(
          key(),
          f.kind,
          {
            type: f.kind,
            caption: detailsSent ? (f.caption ?? null) : details,
            media: {
              providerMediaId: null,
              mimeType: a.file.mimeType,
              fileName: f.fileName,
              sha256: a.file.sha256,
              caption: null,
            },
            items: shownItems([card]),
          },
          a.attachmentId,
        );
        detailsSent = true;
      }
    }
    for (const f of others) {
      const a = await attach(args.organizationId, f.fileId as string, f.kind, f.fileName);
      if (!a) continue;
      last = await args.send(
        key(),
        f.kind,
        {
          type: f.kind,
          caption: f.kind === "document" ? (f.caption ?? card.title) : null,
          media: {
            providerMediaId: null,
            mimeType: a.file.mimeType,
            fileName: f.fileName,
            sha256: a.file.sha256,
            caption: null,
          },
          items: shownItems([card]),
        },
        a.attachmentId,
      );
    }
    // No photos at all: the details as a card with the buttons.
    if (!detailsSent) last = await sendCard(args, args.send, key(), card, action);
    return last;
  }

  /** One item's card, with Book for services and Order for the rest (a tapped list row). */
  async function showItemCard(args: {
    organizationId: string;
    branchId: string;
    send: SendFn;
    stepKey: string;
    itemId: string;
  }) {
    const [card] = await catalogCards(db, {
      organizationId: args.organizationId,
      branchId: args.branchId,
      ids: [args.itemId],
      descriptionChars: 300,
    });
    if (!card)
      return args.send(args.stepKey, "text", {
        type: "text",
        text: "Sorry, I couldn't find that item any more.",
      });
    const [type] = await db
      .select({ kind: schema.catalogType.kind })
      .from(schema.catalogType)
      .innerJoin(schema.catalogItem, eq(schema.catalogItem.typeId, schema.catalogType.id))
      .where(eq(schema.catalogItem.id, card.id));
    return sendCard(args, args.send, args.stepKey, card, type?.kind === "service" ? "book" : "order");
  }

  /**
   * Reads a customer's tap on one of our item buttons: which item, and what they want. Null for any
   * other tap (so the agent answers it as usual).
   */
  async function readTap(messageId: string, replyId: string): Promise<ItemTap | null> {
    const option = optionOfReply(replyId);
    const m = option?.match(/^i(\d{1,2})([mobs])$/);
    if (!m) return null;
    const rows = (await db.execute(sql`
      select b.content from message t join message b on b.id = t.reply_to_message_id
      where t.id = ${messageId} limit 1`)) as unknown as {
      content: { items?: { id: string; title: string }[] };
    }[];
    const item = rows[0]?.content.items?.[Number(m[1])];
    const action = actionOf[m[2] as string];
    return item && action ? { itemId: item.id, action, title: item.title } : null;
  }

  return { showItems, showGallery, showItemCard, sendCard, readTap };
}
