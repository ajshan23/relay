import type { GraphClient } from "../meta/graph";
import type { OutboundMessage } from "../types";

/** What a WhatsApp channel account needs to send: its phone number id and access token. */
export type WhatsAppAccount = { phoneNumberId: string; accessToken: string };

/**
 * The /messages request body for one outbound message. `ourMessageId` goes into
 * biz_opaque_callback_data so status webhooks can be matched even if the send response is lost.
 */
export function buildWhatsAppSendBody(
  to: { phone: string | null; userId: string | null },
  message: OutboundMessage,
  ourMessageId: string,
) {
  const recipient = to.phone ? { to: to.phone } : { recipient: to.userId };
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipient,
    biz_opaque_callback_data: ourMessageId,
  };
  if (message.replyToExternalId) body.context = { message_id: message.replyToExternalId };
  if (message.type === "text") {
    body.type = "text";
    body.text = { body: message.text, preview_url: message.previewUrl ?? false };
  } else {
    body.type = message.type;
    body[message.type] = {
      id: message.providerMediaId,
      ...(message.caption && message.type !== "audio" && message.type !== "sticker"
        ? { caption: message.caption }
        : {}),
      ...(message.type === "document" && message.fileName ? { filename: message.fileName } : {}),
    };
  }
  return body;
}

/** Sends one message. Returns the WhatsApp message id (wamid). Throws GraphError or GraphUncertainError. */
export async function sendWhatsAppMessage(
  graph: GraphClient,
  account: WhatsAppAccount,
  to: { phone: string | null; userId: string | null },
  message: OutboundMessage,
  ourMessageId: string,
): Promise<{ externalId: string }> {
  const res = await graph.request<{ messages?: { id: string }[] }>(
    "POST",
    `${account.phoneNumberId}/messages`,
    account.accessToken,
    buildWhatsAppSendBody(to, message, ourMessageId),
  );
  const externalId = res.messages?.[0]?.id;
  if (!externalId) throw new Error("WhatsApp accepted the message but returned no id");
  return { externalId };
}

/** Marks a customer's message as read (blue ticks) and, optionally, shows "typing…" for up to 25 s. */
export async function markWhatsAppRead(
  graph: GraphClient,
  account: WhatsAppAccount,
  externalId: string,
  typing = false,
) {
  await graph.request("POST", `${account.phoneNumberId}/messages`, account.accessToken, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: externalId,
    ...(typing ? { typing_indicator: { type: "text" } } : {}),
  });
}

/** Checks a token and phone number id, returning what Meta knows about the number. */
export async function describeWhatsAppNumber(graph: GraphClient, account: WhatsAppAccount) {
  return graph.request<{
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  }>(
    "GET",
    `${account.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
    account.accessToken,
  );
}

/** Subscribes our Meta app to the business account's webhooks, so its messages reach us. */
export async function subscribeWhatsAppAccount(graph: GraphClient, wabaId: string, accessToken: string) {
  await graph.request("POST", `${wabaId}/subscribed_apps`, accessToken);
}
