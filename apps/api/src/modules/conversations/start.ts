import { identityScope } from "@relay/channels";
import { newId } from "@relay/core";
import { and, asc, eq, inArray, schema } from "@relay/db";
import { z } from "zod";
import type { AppContext } from "../../context";
import type { Access } from "../branches/access";
import { can } from "../branches/access";

/*
 * Starting a chat from Relay: "New conversation" in the inbox, or "Message on WhatsApp" on a contact.
 * Finds or creates, in this order: the contact (by id, or by phone in the branch), their identity on
 * that channel, and the chat. An existing chat is returned as it is, so nobody gets a duplicate.
 * The first message is sent from the chat itself: outside the 24-hour window that's a template.
 */

export const startBody = z
  .object({
    channelAccountId: z.string().min(1),
    contactId: z.string().optional(),
    /** A number to message when there's no contact yet: digits with country code. */
    phone: z.string().trim().max(30).optional(),
    name: z.string().trim().max(120).optional(),
  })
  .refine((b) => b.contactId || b.phone, { message: "Pick a contact or type a number." });

export type StartResult =
  | { ok: true; conversationId: string; created: boolean }
  | { ok: false; status: 403 | 404 | 409 | 422; code: string; message: string };

const no = (status: 403 | 404 | 409 | 422, code: string, message: string): StartResult => ({
  ok: false,
  status,
  code,
  message,
});

export async function startConversation(
  ctx: AppContext,
  access: Access,
  branchId: string,
  body: z.infer<typeof startBody>,
): Promise<StartResult> {
  const db = ctx.db;

  // The number to send from: this business's, active, and serving this branch.
  const ca = schema.channelAccount;
  const [channel] = await db
    .select()
    .from(ca)
    .where(and(eq(ca.id, body.channelAccountId), eq(ca.organizationId, access.orgId)))
    .limit(1);
  if (!channel) return no(404, "channel_not_found", "That number doesn't exist.");
  if (channel.status !== "active")
    return no(409, "channel_unavailable", `${channel.displayName} isn't active. Check Settings → Channels.`);
  if (channel.branchId !== branchId)
    return no(409, "wrong_branch", `${channel.displayName} isn't connected to this branch.`);
  if (!can(access, "chats.start", { branchId, channelId: channel.id }))
    return no(403, "forbidden", `You can't start chats on ${channel.displayName}.`);
  if (channel.type !== "whatsapp")
    return no(422, "not_supported", "Starting chats is available on WhatsApp numbers for now.");

  // The contact: the one picked, or the branch's contact with this number, or a new one.
  const ct = schema.contact;
  let contact: { id: string; phone: string | null; name: string | null } | undefined;
  if (body.contactId) {
    [contact] = await db
      .select({ id: ct.id, phone: ct.phone, name: ct.name })
      .from(ct)
      .where(and(eq(ct.id, body.contactId), eq(ct.organizationId, access.orgId), eq(ct.branchId, branchId)))
      .limit(1);
    if (!contact) return no(404, "contact_not_found", "That contact isn't in this branch.");
  } else {
    const digits = (body.phone ?? "").replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15)
      return no(422, "invalid_phone", "Type the number with its country code, like +91 98470 12345.");
    [contact] = await db
      .select({ id: ct.id, phone: ct.phone, name: ct.name })
      .from(ct)
      .where(and(eq(ct.organizationId, access.orgId), eq(ct.branchId, branchId), eq(ct.phone, digits)))
      .limit(1);
    if (!contact) {
      const id = newId("contact");
      await db
        .insert(ct)
        .values({ id, organizationId: access.orgId, branchId, phone: digits, name: body.name || null });
      contact = { id, phone: digits, name: body.name || null };
    }
  }

  // Their WhatsApp identity: an existing one (it may only have a WhatsApp user id), or one from the phone.
  const ci = schema.contactIdentity;
  const meta = channel.providerMeta as { wabaId?: string };
  const fallbackScope = meta.wabaId ?? channel.externalId;
  const scope = identityScope(channel.providerMeta, fallbackScope);
  const scopes = [...new Set([scope, fallbackScope])];
  let [identity] = await db
    .select({ id: ci.id, contactId: ci.contactId })
    .from(ci)
    .where(
      and(
        eq(ci.contactId, contact.id),
        eq(ci.branchId, branchId),
        eq(ci.channelType, "whatsapp"),
        inArray(ci.scope, scopes),
      ),
    )
    .orderBy(asc(ci.createdAt))
    .limit(1);
  if (!identity) {
    if (!contact.phone)
      return no(
        422,
        "no_phone",
        "This contact has no phone number yet. Add one to message them on WhatsApp.",
      );
    await db
      .insert(ci)
      .values({
        id: newId("contactIdentity"),
        organizationId: access.orgId,
        contactId: contact.id,
        branchId,
        channelType: "whatsapp",
        scope,
        externalId: contact.phone,
        phone: contact.phone,
        profileName: contact.name,
      })
      .onConflictDoNothing();
    [identity] = await db
      .select({ id: ci.id, contactId: ci.contactId })
      .from(ci)
      .where(
        and(
          eq(ci.organizationId, access.orgId),
          eq(ci.branchId, branchId),
          eq(ci.channelType, "whatsapp"),
          eq(ci.scope, scope),
          eq(ci.externalId, contact.phone),
        ),
      )
      .limit(1);
    if (!identity) return no(409, "conflict", "Couldn't set up this contact on WhatsApp. Try again.");
    // That number may already belong to another contact here (an older chat): use their chat then.
  }

  // The chat: existing one, or a new open one assigned to the person starting it.
  const cv = schema.conversation;
  const inserted = await db
    .insert(cv)
    .values({
      id: newId("conversation"),
      organizationId: access.orgId,
      branchId,
      channelAccountId: channel.id,
      kind: "direct",
      contactId: identity.contactId,
      contactIdentityId: identity.id,
      status: "open",
      assignedUserId: access.userId,
    })
    .onConflictDoNothing()
    .returning({ id: cv.id });
  if (inserted[0]) return { ok: true, conversationId: inserted[0].id, created: true };
  const [existing] = await db
    .select({ id: cv.id })
    .from(cv)
    .where(
      and(eq(cv.channelAccountId, channel.id), eq(cv.contactIdentityId, identity.id), eq(cv.kind, "direct")),
    )
    .limit(1);
  if (!existing) return no(409, "conflict", "Couldn't open the chat. Try again.");
  return { ok: true, conversationId: existing.id, created: false };
}
