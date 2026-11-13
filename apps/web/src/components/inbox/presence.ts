"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";

/*
 * Teammate presence inside Relay: who else has a conversation open and who is typing in it, so two
 * people don't answer the same customer. Never sent to the customer.
 *
 * The browser reports itself to the realtime process (/api/events/presence): "viewing" when a
 * conversation opens and every 20 s while the tab is visible, "typing" at most every 3 s while typing,
 * "left" when it closes. Other tabs learn through the live stream (live.tsx calls applyPresence) and,
 * on open, by asking who is already there.
 */

export type Teammate = { userId: string; name: string; typing: boolean };

type Entry = { name: string; seenAt: number; typingAt: number };

const VIEWING_FOR_MS = 45_000;
const TYPING_FOR_MS = 6_000;
const HEARTBEAT_MS = 20_000;
const TYPING_EVERY_MS = 3_000;

const rooms = new Map<string, Map<string, Entry>>();
const snapshots = new Map<string, Teammate[]>();
const listeners = new Set<() => void>();
const EMPTY: Teammate[] = [];

/** Rebuilds a conversation's list (dropping anyone gone quiet) and tells subscribers if it changed. */
function refresh(conversationId: string) {
  const room = rooms.get(conversationId);
  const now = Date.now();
  const next: Teammate[] = [];
  for (const [userId, e] of room ?? []) {
    if (now - e.seenAt > VIEWING_FOR_MS) room?.delete(userId);
    else next.push({ userId, name: e.name, typing: now - e.typingAt < TYPING_FOR_MS });
  }
  next.sort((a, b) => a.name.localeCompare(b.name));
  const prev = snapshots.get(conversationId) ?? EMPTY;
  const same =
    prev.length === next.length &&
    prev.every((p, i) => p.userId === next[i]?.userId && p.typing === next[i]?.typing);
  if (same) return;
  snapshots.set(conversationId, next.length ? next : EMPTY);
  for (const l of listeners) l();
}

/** Applies a presence event from the live stream. */
export function applyPresence(e: {
  conversationId: string;
  userId: string;
  name: string;
  state: "viewing" | "typing" | "left";
  at?: number;
}) {
  let room = rooms.get(e.conversationId);
  if (!room) {
    room = new Map();
    rooms.set(e.conversationId, room);
  }
  if (e.state === "left") room.delete(e.userId);
  else {
    const now = e.at ?? Date.now();
    const prev = room.get(e.userId);
    room.set(e.userId, {
      name: e.name,
      seenAt: now,
      typingAt: e.state === "typing" ? now : e.state === "viewing" ? 0 : (prev?.typingAt ?? 0),
    });
  }
  refresh(e.conversationId);
}

// Typing and viewing fade out on their own when the reports stop.
if (typeof window !== "undefined")
  setInterval(() => {
    for (const id of rooms.keys()) refresh(id);
  }, 1_000);

/** Teammates (not you) in a conversation right now. */
export function usePresence(conversationId: string): Teammate[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshots.get(conversationId) ?? EMPTY,
    () => EMPTY,
  );
}

const send = (conversationId: string, state: "viewing" | "typing" | "left") =>
  api("/events/presence", { method: "POST", json: { conversationId, state } }).catch(() => undefined);

/** Reports this tab as viewing the conversation while it's open and visible; "left" when it isn't. */
export function usePresenceReporter(conversationId: string) {
  useEffect(() => {
    if (!conversationId) return;
    let here = false;
    const arrive = () => {
      if (document.visibilityState !== "visible") return;
      here = true;
      void send(conversationId, "viewing");
    };
    const leave = () => {
      if (!here) return;
      here = false;
      // Survives the tab closing.
      navigator.sendBeacon?.(
        "/api/events/presence",
        new Blob([JSON.stringify({ conversationId, state: "left" })], { type: "application/json" }),
      ) || void send(conversationId, "left");
    };
    const onVisibility = () => (document.visibilityState === "visible" ? arrive() : leave());

    arrive();
    // Who was already here.
    void api<{ people: { userId: string; name: string; state: "viewing" | "typing"; at: number }[] }>(
      `/events/presence?conversationId=${encodeURIComponent(conversationId)}`,
    )
      .then(({ people }) => {
        for (const p of people) applyPresence({ conversationId, ...p });
      })
      .catch(() => undefined);
    const beat = setInterval(() => {
      if (document.visibilityState === "visible") void send(conversationId, "viewing");
    }, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [conversationId]);
}

const lastTyping = new Map<string, number>();
/** Call on every keystroke in the reply box; reports "typing" at most every 3 s. */
export function reportTyping(conversationId: string) {
  const now = Date.now();
  if (now - (lastTyping.get(conversationId) ?? 0) < TYPING_EVERY_MS) return;
  lastTyping.set(conversationId, now);
  void send(conversationId, "typing");
}

/** "Priya", "Priya and Omar", "Priya, Omar and 2 others". */
export function names(people: Teammate[]) {
  const first = people.map((p) => p.name.split(" ")[0] || p.name);
  if (first.length <= 2) return first.join(" and ");
  return `${first.slice(0, 2).join(", ")} and ${first.length - 2} ${first.length === 3 ? "other" : "others"}`;
}
