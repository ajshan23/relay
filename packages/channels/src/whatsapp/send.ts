import type { GraphClient } from "../meta/graph";
import type { OutboundMessage, Recipient } from "../types";
import { buildWhatsAppTemplateMessage } from "./templates";

/** What a WhatsApp channel account needs to send: its phone number id and access token. */
export type WhatsAppAccount = { phoneNumberId: string; accessToken: string };

/**
 * The /messages request body for one outbound message. `ourMessageId` goes into
 * biz_opaque_callback_data so status webhooks can be matched even if the send response is lost.
 */
export function buildWhatsAppSendBody(to: Recipient, message: OutboundMessage, ourMessageId: string) {
  const recipient =
    to.kind === "group"
      ? { recipient_type: "group", to: to.groupExternalId }
      : { recipient_type: "individual", ...(to.phone ? { to: to.phone } : { recipient: to.userId }) };
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    ...recipient,
    biz_opaque_callback_data: ourMessageId,
  };
  if (message.replyToExternalId && message.type !== "reaction")
    body.context = { message_id: message.replyToExternalId };
  if (message.type === "reaction") {
    body.type = "reaction";
    body.reaction = { message_id: message.targetExternalId, emoji: message.emoji };
  } else if (message.type === "text") {
    body.type = "text";
    body.text = { body: message.text, preview_url: message.previewUrl ?? false };
  } else if (message.type === "template") {
    body.type = "template";
    body.template = buildWhatsAppTemplateMessage(message);
  } else if (message.type === "interactive") {
    body.type = "interactive";
    body.interactive = buildWhatsAppInteractive(message);
  } else if (message.type === "location") {
    body.type = "location";
    body.location = {
      latitude: message.latitude,
      longitude: message.longitude,
      ...(message.name ? { name: message.name } : {}),
      ...(message.address ? { address: message.address } : {}),
    };
  } else {
    body.type = message.type;
    body[message.type] = {
      id: message.providerMediaId,
      ...(message.caption && message.type !== "audio" && message.type !== "sticker"
        ? { caption: message.caption }
        : {}),
      ...(message.type === "document" && message.fileName ? { filename: message.fileName } : {}),
      ...(message.type === "audio" && message.voice ? { voice: true } : {}),
    };
  }
  return body;
}

/** Sends one message. Returns the WhatsApp message id (wamid). Throws GraphError or GraphUncertainError. */
export async function sendWhatsAppMessage(
  graph: GraphClient,
  account: WhatsAppAccount,
  to: Recipient,
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

/**
 * Reply buttons (at most 3, titles ≤ 20) or a list (at most 10 rows, titles ≤ 24, descriptions ≤ 72,
 * button ≤ 20); a link button (text ≤ 20); or a location request. Longer texts are cut rather than
 * refused: Meta rejects the whole message otherwise.
 */
export function buildWhatsAppInteractive(message: Extract<OutboundMessage, { type: "interactive" }>) {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const body = { text: cut(message.body, 1024) };
  if (message.kind === "location_request")
    return { type: "location_request_message", body, action: { name: "send_location" } };
  const footerText = "footer" in message ? message.footer : undefined;
  const footer = footerText ? { footer: { text: cut(footerText, 60) } } : {};
  if (message.kind === "cta_url") {
    const h = message.headerMedia;
    return {
      type: "cta_url",
      ...(h
        ? {
            header: {
              type: h.kind,
              [h.kind]: {
                id: h.providerMediaId,
                ...(h.kind === "document" && h.fileName ? { filename: h.fileName } : {}),
              },
            },
          }
        : {}),
      body,
      ...footer,
      action: {
        name: "cta_url",
        parameters: { display_text: cut(message.button.text, 20), url: message.button.url },
      },
    };
  }
  if (message.kind === "carousel")
    // https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-media-carousel-messages
    return {
      type: "carousel",
      body,
      action: {
        cards: message.cards.slice(0, 10).map((c, i) => ({
          card_index: i,
          type: "cta_url",
          header: { type: c.media.kind, [c.media.kind]: { link: c.media.link } },
          ...(c.body ? { body: { text: cut(c.body, 160) } } : {}),
          action: {
            buttons: c.buttons.slice(0, 2).map((b) => ({
              type: "quick_reply",
              quick_reply: { id: b.id.slice(0, 256), title: cut(b.title, 20) },
            })),
          },
        })),
      },
    };
  if (message.kind === "buttons")
    return {
      type: "button",
      ...(message.headerMedia
        ? {
            header: {
              type: message.headerMedia.kind,
              [message.headerMedia.kind]: { id: message.headerMedia.providerMediaId },
            },
          }
        : {}),
      body,
      ...footer,
      action: {
        buttons: message.options.slice(0, 3).map((o) => ({
          type: "reply",
          reply: { id: o.id.slice(0, 256), title: cut(o.title, 20) },
        })),
      },
    };
  return {
    type: "list",
    body,
    ...footer,
    action: {
      button: cut(message.buttonText || "Choose", 20),
      sections: [
        {
          rows: message.options.slice(0, 10).map((o) => ({
            id: o.id.slice(0, 200),
            title: cut(o.title, 24),
            ...(o.description ? { description: cut(o.description, 72) } : {}),
          })),
        },
      ],
    },
  };
}
