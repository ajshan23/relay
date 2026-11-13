import type { GraphClient } from "../meta/graph";
import type { WhatsAppAccount } from "./send";

/*
 * WhatsApp Groups API (Official Business Account numbers only). Create, update and delete are
 * asynchronous: Meta answers with a request id and the outcome arrives later by webhook
 * (parsed into group.created / group.updated / group.deleted / group.failed).
 * Endpoints: developers.facebook.com/documentation/business-messaging/whatsapp/groups/reference
 */

export type WhatsAppGroupParticipantRef = { userId?: string | null; phone?: string | null };

const requestIdOf = (res: Record<string, unknown>) =>
  (typeof res.request_id === "string" && res.request_id) || (typeof res.id === "string" && res.id) || null;

export async function createWhatsAppGroup(
  graph: GraphClient,
  account: WhatsAppAccount,
  input: { subject: string; description?: string; joinApproval?: boolean },
) {
  const res = await graph.request<Record<string, unknown>>(
    "POST",
    `${account.phoneNumberId}/groups`,
    account.accessToken,
    {
      messaging_product: "whatsapp",
      subject: input.subject,
      ...(input.description ? { description: input.description } : {}),
      join_approval_mode: input.joinApproval ? "approval_required" : "auto_approve",
    },
  );
  return { requestId: requestIdOf(res) };
}

export async function getWhatsAppGroup(graph: GraphClient, account: WhatsAppAccount, groupId: string) {
  return graph.request<{
    id: string;
    subject?: string;
    description?: string;
    suspended?: boolean;
    join_approval_mode?: string;
    total_participant_count?: number;
    participants?: { wa_id?: string; user_id?: string; username?: string }[];
  }>(
    "GET",
    `${groupId}?fields=subject,description,suspended,join_approval_mode,total_participant_count,participants`,
    account.accessToken,
  );
}

export async function updateWhatsAppGroup(
  graph: GraphClient,
  account: WhatsAppAccount,
  groupId: string,
  input: { subject?: string; description?: string },
) {
  const res = await graph.request<Record<string, unknown>>("POST", groupId, account.accessToken, {
    messaging_product: "whatsapp",
    ...input,
  });
  return { requestId: requestIdOf(res) };
}

export async function deleteWhatsAppGroup(graph: GraphClient, account: WhatsAppAccount, groupId: string) {
  const res = await graph.request<Record<string, unknown>>("DELETE", groupId, account.accessToken);
  return { requestId: requestIdOf(res) };
}

export async function getWhatsAppInviteLink(
  graph: GraphClient,
  account: WhatsAppAccount,
  groupId: string,
  reset = false,
) {
  const res = await graph.request<{ invite_link?: string }>(
    reset ? "POST" : "GET",
    `${groupId}/invite_link`,
    account.accessToken,
    reset ? { messaging_product: "whatsapp" } : undefined,
  );
  return res.invite_link ?? null;
}

export async function listWhatsAppJoinRequests(
  graph: GraphClient,
  account: WhatsAppAccount,
  groupId: string,
) {
  const res = await graph.request<{
    data?: {
      join_request_id: string;
      user_id: string;
      wa_id?: string;
      username?: string;
      creation_timestamp?: string;
    }[];
  }>("GET", `${groupId}/join_requests`, account.accessToken);
  return res.data ?? [];
}

export async function decideWhatsAppJoinRequests(
  graph: GraphClient,
  account: WhatsAppAccount,
  groupId: string,
  requestIds: string[],
  approve: boolean,
) {
  await graph.request(approve ? "POST" : "DELETE", `${groupId}/join_requests`, account.accessToken, {
    messaging_product: "whatsapp",
    join_requests: requestIds,
  });
}

/** Removes up to 8 people per call. Removed people cannot rejoin through the invite link. */
export async function removeWhatsAppParticipants(
  graph: GraphClient,
  account: WhatsAppAccount,
  groupId: string,
  people: WhatsAppGroupParticipantRef[],
) {
  for (let i = 0; i < people.length; i += 8) {
    const batch = people.slice(i, i + 8).map((p) => (p.userId ? { user_id: p.userId } : { user: p.phone }));
    await graph.request("DELETE", `${groupId}/participants`, account.accessToken, {
      messaging_product: "whatsapp",
      participants: batch,
    });
  }
}
