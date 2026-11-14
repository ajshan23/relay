"use client";

import { Icon } from "@relay/ui/components/icon";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relay/ui/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Upload } from "./types";

/*
 * Record a voice note in the browser and send it as a WhatsApp voice message. The browser records in
 * its own format (Chrome WebM/Opus, Safari MP4, Firefox Ogg/Opus); the server turns it into
 * Ogg/Opus mono, which WhatsApp shows as a voice note.
 */

/** WhatsApp plays voice notes up to 512 KB inline: about 2.5 minutes at our quality. */
const MAX_SECONDS = 150;

const preferred = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4", "audio/webm"];

export function VoiceRecorder({
  conversationId,
  disabled,
  onRecorded,
  onRecordingChange,
}: {
  conversationId: string;
  disabled?: boolean;
  /** The converted voice note, ready to send. */
  onRecorded: (upload: Upload) => void;
  onRecordingChange?: (recording: boolean) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "uploading">("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => onRecordingChange?.(state !== "idle"), [state, onRecordingChange]);
  // Stop the microphone if the chat closes mid-recording.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on unmount with the refs as they are then
  useEffect(() => () => stopTracks(), []);

  function stopTracks() {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    recorder.current?.stream.getTracks().forEach((t) => {
      t.stop();
    });
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      notify.error("This browser can't record audio");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
      });
    } catch {
      notify.error("Microphone not available", {
        description: "Allow microphone access for this site and try again.",
      });
      return;
    }
    const mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
    chunks.current = [];
    cancelled.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    rec.onstop = () => void finish(rec.mimeType || mimeType || "audio/webm");
    recorder.current = rec;
    rec.start(250);
    setSeconds(0);
    setState("recording");
    const began = Date.now();
    timer.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - began) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) rec.stop();
    }, 250);
  }

  async function finish(type: string) {
    stopTracks();
    if (cancelled.current || !chunks.current.length) {
      setState("idle");
      return;
    }
    setState("uploading");
    const blob = new Blob(chunks.current, { type });
    const form = new FormData();
    form.set("conversationId", conversationId);
    form.set("use", "voice");
    form.set(
      "file",
      new File([blob], `voice.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`, {
        type,
      }),
    );
    try {
      const { upload } = await api<{ upload: Upload }>("/uploads", { method: "POST", body: form });
      onRecorded(upload);
    } catch (err) {
      notify.error("Voice note not sent", {
        description: err instanceof ApiError ? err.message : "Check your connection.",
      });
    } finally {
      setState("idle");
    }
  }

  function stop(send: boolean) {
    cancelled.current = !send;
    if (recorder.current?.state === "recording") recorder.current.stop();
    else stopTracks();
  }

  if (state === "idle")
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Record a voice note"
            disabled={disabled}
            onClick={() => void start()}
          >
            <Icon name="mic" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Record a voice note</TooltipContent>
      </Tooltip>
    );

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <span
      className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
      role="status"
      aria-live="polite"
    >
      {state === "recording" ? (
        <>
          <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden />
          <span className="text-xs font-medium tabular-nums">{clock}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Discard the voice note"
            onClick={() => stop(false)}
          >
            <Icon name="close" />
          </Button>
          <Button type="button" size="icon-xs" aria-label="Send the voice note" onClick={() => stop(true)}>
            <Icon name="send" />
          </Button>
        </>
      ) : (
        <>
          <Icon name="loading" size="xs" className="animate-spin" />
          <span className="text-xs">Sending voice note…</span>
        </>
      )}
    </span>
  );
}
