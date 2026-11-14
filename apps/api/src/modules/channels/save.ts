import { encryptSecret, newId } from "@relay/core";
import { and, eq, schema } from "@relay/db";
import type { AppContext } from "../../context";

/*
 * Storing a WhatsApp number, shared by the manual connect and Embedded Signup.
 * Rules:
 *   - a number is connected once in all of Relay: another business's number is refused;
 *   - a number this business had before is reused, so its conversations and history stay;
 *   - reconnecting a channel must bring back that same number;
 *   - a new channel belongs to the branch it was connected from (reconnects keep their branches).
 */

export type SaveWhatsAppInput = {
  orgId: string;
  phoneNumberId: string;
  /** Secrets, stored encrypted: { accessToken, pin? }. */
  credentials: Record<string, unknown>;
  displayName: string;
  displayPhone: string | null;
  providerMeta: Record<string, unknown>;
  status: "active" | "setting_up";
  /** The branch it is connected from (new channels). */
  branchIds: string[];
  /** Embedded Signup "Reconnect" on this channel: the number must be the same. */
  reconnectChannelId?: string | null;
  /** The manual route refuses a number that is already active in this business. */
  allowActive: boolean;
};

export type SaveWhatsAppResult =
  | { ok: true; id: string; reconnected: boolean }
  | { ok: false; status: 404 | 409; code: string; message: string };

export async function saveWhatsAppChannel(
  ctx: AppContext,
  key: string,
  input: SaveWhatsAppInput,
): Promise<SaveWhatsAppResult> {
  const ca = schema.channelAccount;
  const [existing] = await ctx.db
    .select({
      id: ca.id,
      organizationId: ca.organizationId,
      status: ca.status,
      providerMeta: ca.providerMeta,
    })
    .from(ca)
    .where(and(eq(ca.type, "whatsapp"), eq(ca.externalId, input.phoneNumberId)))
    .limit(1);

  if (existing && existing.organizationId !== input.orgId)
    return {
      ok: false,
      status: 409,
      code: "taken",
      message: "This WhatsApp number is connected to another business on Relay.",
    };
  if (input.reconnectChannelId) {
    const [target] = await ctx.db
      .select({ id: ca.id })
      .from(ca)
      .where(and(eq(ca.id, input.reconnectChannelId), eq(ca.organizationId, input.orgId)))
      .limit(1);
    if (!target) return { ok: false, status: 404, code: "not_found", message: "That channel doesn't exist." };
    if (!existing || existing.id !== target.id)
      return {
        ok: false,
        status: 409,
        code: "different_number",
        message:
          "That's a different number from the one you're reconnecting. Pick the same number in Meta's window.",
      };
  }
  if (existing && existing.status !== "disconnected" && !input.allowActive && !input.reconnectChannelId)
    return {
      ok: false,
      status: 409,
      code: "already_connected",
      message: "This WhatsApp number is already connected to Relay.",
    };

  const values = {
    organizationId: input.orgId,
    type: "whatsapp" as const,
    provider: "meta",
    externalId: input.phoneNumberId,
    displayName: input.displayName,
    displayPhone: input.displayPhone,
    status: input.status,
    statusReason: null,
    credentials: encryptSecret(input.credentials, key),
    // Keep what we learned before (coexistence progress, username) unless it is replaced.
    providerMeta: { ...(existing?.providerMeta ?? {}), ...input.providerMeta },
    updatedAt: new Date(),
  };

  const id = await ctx.db.transaction(async (tx) => {
    if (existing) {
      await tx.update(ca).set(values).where(eq(ca.id, existing.id));
      // A reconnect keeps its branches; a disconnected number coming back gets the branch it's connected from.
      if (!input.reconnectChannelId && input.branchIds.length) {
        await tx
          .delete(schema.channelAccountBranch)
          .where(eq(schema.channelAccountBranch.channelAccountId, existing.id));
        await tx
          .insert(schema.channelAccountBranch)
          .values(
            input.branchIds.map((branchId) => ({
              channelAccountId: existing.id,
              branchId,
              organizationId: input.orgId,
            })),
          );
        await tx.update(ca).set({ defaultBranchId: input.branchIds[0] }).where(eq(ca.id, existing.id));
      }
      return existing.id;
    }
    const channelId = newId("channelAccount");
    await tx.insert(ca).values({ id: channelId, ...values, defaultBranchId: input.branchIds[0] ?? null });
    if (input.branchIds.length)
      await tx
        .insert(schema.channelAccountBranch)
        .values(
          input.branchIds.map((branchId) => ({
            channelAccountId: channelId,
            branchId,
            organizationId: input.orgId,
          })),
        );
    return channelId;
  });
  return { ok: true, id, reconnected: !!existing };
}
