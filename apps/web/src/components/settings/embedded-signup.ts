/*
 * Meta's Embedded Signup popup (v5), as plain logic with no React so it can be tested.
 * Two things come back, in either order: the login callback's `code` (valid ~30 s) and a
 * WA_EMBEDDED_SIGNUP message from facebook.com saying how the popup ended and which ids were picked.
 * The code is sent as soon as it arrives; the session is waited for a few seconds at most, because the
 * server checks every id with Meta anyway. Adapted from FlowFlex's tested embeddedSignup.ts, for v5
 * (messaging_account_ids instead of waba_id, is_on_biz_app, coexistence finish event).
 */

export type SignupSession = {
  event?: string;
  phoneNumberId?: string;
  messagingAccountIds?: string[];
  businessId?: string;
  isOnBizApp?: boolean;
};

export type SignupOutcome = { code: string; session: SignupSession };

export class SignupStopped extends Error {
  constructor(
    readonly kind: "cancelled" | "error",
    message: string,
  ) {
    super(message);
  }
}

export type SignupMessage =
  | { type: "finish"; session: SignupSession }
  | { type: "cancel" }
  | { type: "error"; message: string }
  | { type: "no_number" };

/** Only https facebook.com (or a subdomain such as web.facebook.com), with no port. */
export function trustedOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      !url.port &&
      (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"))
    );
  } catch {
    return false;
  }
}

const idList = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x)) : [];
const id = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? v : undefined);

/** Reads one postMessage; null when it isn't Meta's signup message. */
export function readSignupMessage(origin: string, raw: unknown): SignupMessage | null {
  if (!trustedOrigin(origin)) return null;
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const msg = data as { type?: unknown; event?: unknown; data?: Record<string, unknown> };
  if (msg.type !== "WA_EMBEDDED_SIGNUP" || typeof msg.event !== "string") return null;
  const event = msg.event.toUpperCase();
  const d = msg.data ?? {};
  if (event === "FINISH" || event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
    // v5 names the accounts messaging_account_ids; v4 and older sent waba_id.
    const accounts = idList(d.messaging_account_ids);
    const legacy = id(d.waba_id);
    return {
      type: "finish",
      session: {
        event,
        phoneNumberId: id(d.phone_number_id),
        messagingAccountIds: accounts.length ? accounts : legacy ? [legacy] : [],
        businessId: id(d.business_id),
        isOnBizApp:
          typeof d.is_on_biz_app === "boolean"
            ? d.is_on_biz_app
            : event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      },
    };
  }
  if (event === "FINISH_ONLY_WABA" || event.startsWith("FINISH")) return { type: "no_number" };
  if (event === "CANCEL") {
    // Meta reports some failures as CANCEL with an error message.
    const text = typeof d.error_message === "string" ? d.error_message : null;
    return text ? { type: "error", message: text } : { type: "cancel" };
  }
  if (event === "ERROR")
    return {
      type: "error",
      message: typeof d.error_message === "string" ? d.error_message : "Meta reported an error.",
    };
  return null;
}

type LoginResponse = { authResponse?: { code?: string } | null; status?: string; error?: unknown };

export type SignupDeps = {
  /** Calls FB.login(callback, options). Must run inside the click handler (popup blockers). */
  login: (callback: (res: LoginResponse) => void) => void;
  listen: (handler: (e: { origin: string; data: unknown }) => void) => () => void;
  schedule: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

/** How long to wait for the session message after the code arrives. */
export const SESSION_GRACE_MS = 5_000;
/** A popup that never calls back is given up on after this. */
export const LOGIN_DEADLINE_MS = 15 * 60_000;

/**
 * Opens Meta's popup and resolves with the code and whatever the popup told us. Rejects with
 * SignupStopped (cancelled, or an error with Meta's words).
 */
export function runSignup(deps: SignupDeps): Promise<SignupOutcome> {
  return new Promise((resolve, reject) => {
    let code: string | null = null;
    let session: SignupSession | null = null;
    let done = false;
    let grace: unknown = null;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      stop();
      if (grace !== null) deps.clear(grace);
      deps.clear(deadline);
      fn();
    };
    const ready = () => {
      if (code && session) finish(() => resolve({ code: code as string, session: session as SignupSession }));
    };
    const stop = deps.listen((e) => {
      const msg = readSignupMessage(e.origin, e.data);
      if (!msg) return;
      if (msg.type === "finish") {
        // Keep the first finish (a coexistence finish must not be overwritten by a later plain one).
        session ??= msg.session;
        ready();
      } else if (msg.type === "cancel") {
        finish(() => reject(new SignupStopped("cancelled", "You closed Meta's window before finishing.")));
      } else if (msg.type === "no_number") {
        finish(() =>
          reject(
            new SignupStopped(
              "error",
              "Meta finished without a phone number. Run the setup again and add a number.",
            ),
          ),
        );
      } else {
        finish(() => reject(new SignupStopped("error", msg.message)));
      }
    });
    const deadline = deps.schedule(
      () => finish(() => reject(new SignupStopped("error", "Meta's window didn't finish. Try again."))),
      LOGIN_DEADLINE_MS,
    );
    try {
      deps.login((res) => {
        const c = res?.authResponse?.code;
        if (!c) {
          finish(() => reject(new SignupStopped("cancelled", "Meta's window was closed before finishing.")));
          return;
        }
        code = c;
        if (session) return ready();
        // The code expires quickly: go with what we have if the session message is late.
        grace = deps.schedule(
          () => finish(() => resolve({ code: c, session: session ?? {} })),
          SESSION_GRACE_MS,
        );
      });
    } catch {
      finish(() =>
        reject(
          new SignupStopped(
            "error",
            "Meta's window couldn't open. Allow pop-ups for this site and try again.",
          ),
        ),
      );
    }
  });
}
