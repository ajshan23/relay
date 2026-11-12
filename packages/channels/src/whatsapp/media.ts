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
