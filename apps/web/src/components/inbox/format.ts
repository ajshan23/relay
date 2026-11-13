import type { Message, Preview } from "./types";

/** "14:05" today, "Yesterday", "Mon" this week, otherwise "12 Nov" (or "12 Nov 2025" in another year). */
export function listTime(iso: string, now = new Date()) {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Day separator text: "Today", "Yesterday", or "Wednesday, 12 November". */
export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, now)) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export function fileSize(bytes: number | null | undefined) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** "2 h 15 m left", "12 m left", "Closed". */
export function windowLeft(expiresAt: string | null, now = Date.now()) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} m left` : `${m} m left`;
}

const kindWords: Record<string, string> = {
  image: "Photo",
  video: "Video",
  audio: "Voice message",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contacts: "Contact card",
  reaction: "Reaction",
  order: "Order",
  interactive: "Reply",
  button: "Reply",
  unsupported: "Unsupported message",
};

/** One line for the conversation list. */
export function previewLine(p: Preview | null, kind: "direct" | "group") {
  if (!p) return "No messages yet";
  const what =
    p.type === "text"
      ? (p.text ?? "")
      : p.text
        ? `${kindWords[p.type] ?? "Message"}: ${p.text}`
        : (kindWords[p.type] ?? "Message");
  const who = p.direction === "outbound" ? "You" : kind === "group" ? p.senderName : null;
  return who ? `${who}: ${what}` : what;
}

/** Plain words for why a message failed. */
export function failureText(m: Message) {
  const reason = m.error?.reason;
  const known: Record<string, string> = {
    window_closed: "Not sent: the 24-hour reply window had closed.",
    group_unavailable: "Not sent: the group is suspended or deleted.",
    unsupported_in_group: "Not sent: this kind of message can't go to a group.",
    channel_unavailable: "Not sent: the channel is disconnected.",
    authFailed: "Not sent: the channel's access was refused. Reconnect the channel.",
    rateLimited: "Not sent: the channel was busy. Try again.",
    unknown: "May not have been sent: the channel didn't answer in time.",
  };
  const fromChannel = m.error?.errors?.[0]?.message ?? m.error?.message;
  return (reason && known[reason]) ?? (fromChannel ? `Not sent: ${fromChannel}` : "Not sent.");
}

export const kindWord = (type: string) => kindWords[type] ?? "Message";

export const members = (n: number) => `${n} ${n === 1 ? "member" : "members"}`;
