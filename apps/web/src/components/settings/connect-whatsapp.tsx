"use client";

import { Icon } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { keys } from "@/components/inbox/queries";
import type { ChannelSummary } from "@/components/inbox/types";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError, api } from "@/lib/api";
import { runSignup, type SignupSession, SignupStopped } from "./embedded-signup";

/*
 * "Connect WhatsApp": Meta's Embedded Signup, opened from Settings → Channels. The number is connected
 * to the branch you're working in. Meta's SDK is loaded when the page opens, so the window opens
 * straight from the click (browsers block pop-ups opened after a wait).
 */

type FbLogin = (
  cb: (res: { authResponse?: { code?: string } | null; status?: string }) => void,
  opts: Record<string, unknown>,
) => void;
declare global {
  interface Window {
    FB?: { init: (o: Record<string, unknown>) => void; login: FbLogin };
    fbAsyncInit?: () => void;
  }
}

type SignupConfig = { enabled: boolean; appId: string | null; configId: string | null; graphVersion: string };

export function useSignupConfig() {
  return useQuery({
    queryKey: ["channels", "signup-config"],
    queryFn: () => api<SignupConfig>("/channels/whatsapp/signup-config"),
    staleTime: 10 * 60_000,
  });
}

/** Loads Meta's JavaScript SDK once and initialises it with our app. */
function useFacebookSdk(config: SignupConfig | undefined) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!config?.enabled || !config.appId) return;
    const init = () => {
      window.FB?.init({
        appId: config.appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: config.graphVersion,
      });
      setReady(true);
    };
    if (window.FB) return init();
    window.fbAsyncInit = init;
    if (!document.getElementById("facebook-jssdk")) {
      const s = document.createElement("script");
      s.id = "facebook-jssdk";
      s.src = "https://connect.facebook.net/en_US/sdk.js";
      s.async = true;
      s.defer = true;
      s.crossOrigin = "anonymous";
      s.onerror = () => setReady(false);
      document.body.appendChild(s);
    }
  }, [config]);
  return ready;
}

type Phase =
  | { step: "idle" }
  | { step: "meta" }
  | { step: "connecting" }
  | { step: "done"; channel: ChannelSummary | null; warning: string | null; reconnected: boolean }
  | { step: "error"; message: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Connect / Reconnect flow and its progress dialog. */
export function useConnectWhatsApp() {
  const config = useSignupConfig();
  const sdkReady = useFacebookSdk(config.data);
  const { branch } = useBranch();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const reconnectRef = useRef<string | null>(null);

  // Leaving mid-way would lose the connection Meta just made.
  useEffect(() => {
    if (phase.step !== "meta" && phase.step !== "connecting") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase.step]);

  const finish = useCallback(
    async (attemptId: string, code: string, session: SignupSession) => {
      setPhase({ step: "connecting" });
      const body = { attemptId, code, session, reconnectChannelId: reconnectRef.current ?? undefined };
      const done = (channel: ChannelSummary | null, warning: string | null, reconnected: boolean) => {
        void qc.invalidateQueries({ queryKey: keys.channels() });
        setPhase({ step: "done", channel, warning, reconnected });
      };
      try {
        const res = await api<{ channel: ChannelSummary; setupError: string | null }>(
          `/channels/whatsapp/embedded-signup?branch=${encodeURIComponent(branch.id)}`,
          { method: "POST", json: body },
        );
        done(res.channel, res.setupError, !!reconnectRef.current);
      } catch (err) {
        // A lost answer: the server may have finished. Ask, rather than reusing the one-time code.
        const uncertain = !(err instanceof ApiError) || err.status >= 502;
        if (uncertain) {
          for (let i = 0; i < 10; i++) {
            await wait(2000);
            const r = await api<{ attempt: { status: string; errorMessage: string | null } }>(
              `/channels/whatsapp/embedded-signup/${attemptId}`,
            ).catch(() => null);
            if (r?.attempt.status === "done")
              return done(null, r.attempt.errorMessage, !!reconnectRef.current);
            if (r?.attempt.status === "failed")
              return setPhase({ step: "error", message: r.attempt.errorMessage ?? "Connecting failed." });
          }
        }
        setPhase({
          step: "error",
          message:
            err instanceof ApiError
              ? err.message
              : "Couldn't reach Relay. Check Settings → Channels in a minute.",
        });
      }
    },
    [branch.id, qc],
  );

  /** Must be called straight from a click: it opens Meta's window. */
  const start = useCallback(
    (reconnectChannelId?: string) => {
      const cfg = config.data;
      if (!cfg?.enabled || !cfg.configId) {
        notify.error("WhatsApp signup isn't set up on this server yet");
        return;
      }
      if (!window.FB || !sdkReady) {
        notify.error("Meta's sign-in is still loading", { description: "Wait a moment and try again." });
        return;
      }
      reconnectRef.current = reconnectChannelId ?? null;
      const attemptId = crypto.randomUUID();
      setPhase({ step: "meta" });
      const fb = window.FB;
      runSignup({
        login: (cb) =>
          fb.login(cb, {
            config_id: cfg.configId,
            response_type: "code",
            override_default_response_type: true,
            extras: { version: "v5", setup: {} },
          }),
        listen: (handler) => {
          const fn = (e: MessageEvent) => handler({ origin: e.origin, data: e.data });
          window.addEventListener("message", fn);
          return () => window.removeEventListener("message", fn);
        },
        schedule: (fn, ms) => window.setTimeout(fn, ms),
        clear: (t) => window.clearTimeout(t as number),
      })
        .then(({ code, session }) => finish(attemptId, code, session))
        .catch((err: unknown) => {
          if (err instanceof SignupStopped && err.kind === "cancelled") {
            setPhase({ step: "idle" });
            notify.info("WhatsApp setup cancelled");
            return;
          }
          setPhase({ step: "error", message: err instanceof Error ? err.message : "Something went wrong." });
        });
    },
    [config.data, sdkReady, finish],
  );

  const dialog = (
    <Modal
      open={phase.step !== "idle"}
      onOpenChange={(open) => {
        if (!open && (phase.step === "done" || phase.step === "error")) setPhase({ step: "idle" });
      }}
      hideClose={phase.step === "meta" || phase.step === "connecting"}
      title={
        phase.step === "done"
          ? phase.reconnected
            ? "WhatsApp reconnected"
            : "WhatsApp connected"
          : phase.step === "error"
            ? "Couldn't connect WhatsApp"
            : "Connecting WhatsApp"
      }
      description={phase.step === "idle" ? undefined : `For ${branch.name}`}
      size="sm"
      footer={
        phase.step === "done" ? (
          <ModalActions>
            <Button onClick={() => setPhase({ step: "idle" })}>Done</Button>
          </ModalActions>
        ) : phase.step === "error" ? (
          <ModalActions>
            <Button variant="outline" onClick={() => setPhase({ step: "idle" })}>
              Close
            </Button>
            <Button onClick={() => start(reconnectRef.current ?? undefined)}>Try again</Button>
          </ModalActions>
        ) : undefined
      }
    >
      <div className="flex items-start gap-3 px-6 pb-5 text-sm">
        {phase.step === "meta" || phase.step === "connecting" ? (
          <>
            <Icon name="loading" className="mt-0.5 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">
              {phase.step === "meta"
                ? "Finish the steps in Meta's window. Pick your business and the WhatsApp number to use."
                : "Connecting your number: checking it with Meta and turning on messages…"}
            </p>
          </>
        ) : phase.step === "done" ? (
          <>
            <Icon
              name={phase.warning ? "warning" : "success"}
              className={phase.warning ? "mt-0.5 text-warning" : "mt-0.5 text-good"}
            />
            <div className="flex flex-col gap-1">
              <p>
                {phase.channel?.displayName ?? "Your number"}
                {phase.channel?.displayPhone ? ` (${phase.channel.displayPhone})` : ""} is ready in Relay.
              </p>
              {phase.warning ? <p className="text-muted-foreground">{phase.warning}</p> : null}
              {(phase.channel?.providerMeta as { onboarding?: { coexistence?: boolean } } | undefined)
                ?.onboarding?.coexistence ? (
                <p className="text-muted-foreground">
                  You can keep using the WhatsApp Business app. Your contacts and recent chats are being
                  copied into Relay; this can take a few minutes.
                </p>
              ) : null}
            </div>
          </>
        ) : phase.step === "error" ? (
          <>
            <Icon name="alert" className="mt-0.5 text-destructive" />
            <p>{phase.message}</p>
          </>
        ) : null}
      </div>
    </Modal>
  );

  return {
    start,
    dialog,
    available: !!config.data?.enabled,
    loading: config.isPending || (!!config.data?.enabled && !sdkReady),
    busy: phase.step === "meta" || phase.step === "connecting",
  };
}
