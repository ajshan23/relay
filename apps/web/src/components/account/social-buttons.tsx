"use client";

import { Button } from "@relay/ui/ui/button";
import { FieldSeparator } from "@relay/ui/ui/field";
import { Spinner } from "@relay/ui/ui/spinner";
import { useState } from "react";
import { signIn } from "@/lib/auth-client";
import { useAuthOptions } from "./auth-options";

/** Google's four-colour "G", as Google's brand rules require on sign-in buttons. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  );
}

/**
 * "Continue with Google" and the "or" line under it. `next` is where to land after signing in;
 * new accounts go to onboarding. If the server has no Google keys yet, the button says so instead of failing.
 */
export function SocialButtons({ next, disabled }: { next: string; disabled?: boolean }) {
  const { google } = useAuthOptions();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full gap-2.5 text-[14px] font-medium"
          disabled={disabled || pending}
          onClick={async () => {
            setMessage(null);
            if (!google) {
              setMessage("Google sign-in isn't switched on yet. Use your email for now.");
              return;
            }
            setPending(true);
            const { error } = await signIn.social({
              provider: "google",
              callbackURL: next,
              newUserCallbackURL: "/onboarding",
              errorCallbackURL: "/sign-in?error=google",
            });
            if (error) {
              setMessage("Google sign-in didn't start. Try again, or use your email.");
              setPending(false);
            }
          }}
        >
          {pending ? <Spinner /> : <GoogleMark />}
          Continue with Google
        </Button>
        {message ? (
          <p role="status" className="text-center text-[13px] text-muted-foreground">
            {message}
          </p>
        ) : null}
      </div>
      <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card text-[13px]">
        or
      </FieldSeparator>
    </div>
  );
}
