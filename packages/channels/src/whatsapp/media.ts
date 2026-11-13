import type { GraphClient } from "../meta/graph";
import type { WhatsAppAccount } from "./send";

/**
 * Downloads an inbound file: GET /{media-id} gives a short-lived URL (5 minutes), which is then
 * fetched with the same token. Media ids expire after 7 days, so this runs soon after arrival.
 */
export async function fetchWhatsAppMedia(
  graph: GraphClient,
  account: WhatsAppAccount,
  mediaId: string,
  maxBytes: number,
) {
  const info = await graph.request<{ url: string; mime_type?: string; sha256?: string; file_size?: number }>(
    "GET",
    mediaId,
    account.accessToken,
  );
  const file = await graph.download(info.url, account.accessToken, maxBytes);
  return { bytes: file.bytes, mimeType: info.mime_type ?? file.mimeType, sha256: info.sha256 ?? null };
}

/**
 * Uploads a file for sending: POST /{phone-number-id}/media returns a media id used in the send call.
 * Safe to repeat: an upload that is never used simply expires on Meta's side.
 */
export async function uploadWhatsAppMedia(
  graph: GraphClient,
  account: WhatsAppAccount,
  file: { bytes: Uint8Array; mimeType: string; fileName: string },
): Promise<{ providerMediaId: string }> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", file.mimeType);
  form.set("file", new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.fileName);
  const res = await graph.request<{ id?: string }>(
    "POST",
    `${account.phoneNumberId}/media`,
    account.accessToken,
    form,
  );
  if (!res.id) throw new Error("WhatsApp accepted the upload but returned no media id");
  return { providerMediaId: res.id };
}
