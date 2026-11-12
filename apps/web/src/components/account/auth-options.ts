"use client";

import { useEffect, useState } from "react";

/** What the server allows on the sign-in screens. Mirrors GET /api/auth-options. */
export type AuthOptions = { google: boolean; emailVerification: boolean; passwordMinLength: number };

const fallback: AuthOptions = { google: false, emailVerification: true, passwordMinLength: 10 };
let cached: AuthOptions | null = null;

/** Loads the sign-in options once per visit. Until they arrive, social buttons stay hidden. */
export function useAuthOptions(): AuthOptions {
  const [options, setOptions] = useState<AuthOptions>(cached ?? fallback);
  useEffect(() => {
    if (cached) return;
    fetch("/api/auth-options")
      .then((res) => (res.ok ? (res.json() as Promise<AuthOptions>) : fallback))
      .then((next) => {
        cached = next;
        setOptions(next);
      })
      .catch(() => {});
  }, []);
  return options;
}

const VERIFY_KEY = "relay.verify-email";

/** Remembers which email is waiting for its code, so the address never goes in the URL. */
export function rememberPendingEmail(email: string) {
  try {
    window.sessionStorage.setItem(VERIFY_KEY, email);
  } catch {
    // Storage blocked: the verify screen asks for the email instead.
  }
}

export function readPendingEmail(): string | null {
  try {
    return window.sessionStorage.getItem(VERIFY_KEY);
  } catch {
    return null;
  }
}

export function forgetPendingEmail() {
  try {
    window.sessionStorage.removeItem(VERIFY_KEY);
  } catch {
    // Nothing to clear.
  }
}
