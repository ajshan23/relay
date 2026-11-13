/*
 * Shared inbox pieces used by the API and the worker: the short preview a conversation list shows,
 * and the live events that tell open browsers something changed.
 *
 * Events are small hints ("conversation X changed"), never the data itself: the browser refetches
 * what it shows, so access rules stay in one place (the API's read routes).
 */

export type MessagePreview = {
  type: string;
  text: string | null;
  direction: "inbound" | "outbound";
  senderName: string | null;
};

/** One line of text for a message in Relay's normalized shape, or null when nothing readable. */
export function previewText(content: Record<string, unknown>): string | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const media = content.media as Record<string, unknown> | undefined;
  switch (content.type) {
    case "text":
      return str(content.text);
    case "reaction":
      return str(content.emoji);
    case "location":
      return str(content.name) ?? str(content.address);
    case "button":
      return str(content.text);
    case "interactive":
      return str(content.title) ?? str(content.name);
    case "order":
      return str(content.text);
    case "template":
      return str(content.body);
    default:
      return media ? (str(media.caption) ?? str(media.fileName)) : str(content.caption);
  }
}

export function messagePreview(
  type: string,
  content: Record<string, unknown>,
  direction: "inbound" | "outbound",
  senderName: string | null = null,
): MessagePreview {
  return { type, text: previewText(content)?.slice(0, 160) ?? null, direction, senderName };
}

/** What a teammate is doing in a conversation. "left" clears them. */
export type PresenceState = "viewing" | "typing" | "left";

export type InboxEvent =
  /** Anything on the conversation changed: new message, assignee, status, window. */
  | { type: "conversation.updated"; conversationId: string; branchId: string | null }
  /** A message changed (status, attachment stored) without a new message arriving. */
  | { type: "message.updated"; conversationId: string; branchId: string | null; messageId: string }
  /** One person read a conversation. Only that person's unread count changes. */
  | { type: "conversation.read"; conversationId: string; branchId: string | null; userId: string }
  /** A teammate opened, is typing in, or left a conversation. Only shown inside Relay. */
  | {
      type: "presence";
      conversationId: string;
      branchId: string | null;
      userId: string;
      name: string;
      state: PresenceState;
    }
  /** A template or its review state on a channel changed. Templates are organization-wide. */
  | { type: "template.updated"; templateId: string };

/** Anything with Redis's publish (ioredis client). */
export type Publisher = { publish(channel: string, message: string): Promise<unknown> };

export const inboxChannel = (organizationId: string) => `relay:org:${organizationId}`;

/** Tells every open inbox of the organization. Never throws: a missed hint only delays a refresh. */
export async function publishInboxEvent(redis: Publisher, organizationId: string, event: InboxEvent) {
  try {
    await redis.publish(inboxChannel(organizationId), JSON.stringify(event));
  } catch (err) {
    console.warn("inbox event not published", err);
  }
}
