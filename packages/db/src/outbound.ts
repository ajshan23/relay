import { messagePreview } from "@relay/core";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema/index";

/*
 * Saving an outgoing message, shared by everything that sends one: the inbox (a person), automations
 * (the bot) and later the AI agent. One transaction stores the message as "queued", links an uploaded
 * file and updates the chat's preview; the caller then queues it for the outbox, which sends it.
 *
 * An automation step passes its step key: if that step already saved its message (the worker crashed
 * and the step ran again), the existing message comes back with created: false and nothing is added,
 * so a customer never gets the same automated message twice.
 */

export type OutboundInput = {
  conversation: { id: string; organizationId: string; channelAccountId: string };
  type: string;
  content: Record<string, unknown>;
  senderType: "user" | "bot" | "ai_agent" | "system";
  senderUserId?: string | null;
  /** Shown as the preview's author ("Asha: …"). */
  senderName?: string | null;
  replyToMessageId?: string | null;
  /** An uploaded file to attach (must not be attached to another message yet). */
  attachmentId?: string | null;
  automationId?: string | null;
  automationStepKey?: string | null;
  id: string;
  now?: Date;
};

export class AttachmentTaken extends Error {}

export async function insertOutboundMessage(db: Db, input: OutboundInput) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(schema.message)
      .values({
        id: input.id,
        organizationId: input.conversation.organizationId,
        conversationId: input.conversation.id,
        channelAccountId: input.conversation.channelAccountId,
        direction: "outbound",
        senderType: input.senderType,
        senderUserId: input.senderUserId ?? null,
        type: input.type,
        content: input.content,
        status: "queued",
        replyToMessageId: input.replyToMessageId ?? null,
        automationId: input.automationId ?? null,
        automationStepKey: input.automationStepKey ?? null,
        sentAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (!row) {
      if (!input.automationStepKey) throw new Error("message could not be saved");
      const [existing] = await tx
        .select()
        .from(schema.message)
        .where(eq(schema.message.automationStepKey, input.automationStepKey))
        .limit(1);
      if (!existing) throw new Error("message could not be saved");
      return { message: existing, created: false };
    }
    if (input.attachmentId) {
      const linked = await tx
        .update(schema.attachment)
        .set({ messageId: input.id })
        .where(and(eq(schema.attachment.id, input.attachmentId), isNull(schema.attachment.messageId)))
        .returning({ id: schema.attachment.id });
      if (!linked.length) throw new AttachmentTaken("upload already used");
    }
    await tx
      .update(schema.conversation)
      .set({
        lastMessageAt: now,
        lastMessagePreview: messagePreview(input.type, input.content, "outbound", input.senderName ?? null),
        updatedAt: now,
      })
      .where(eq(schema.conversation.id, input.conversation.id));
    return { message: row, created: true };
  });
}
