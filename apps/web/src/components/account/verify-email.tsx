"use client";

import { Button } from "@relay/ui/ui/button";
import { Field, FieldLabel } from "@relay/ui/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@relay/ui/ui/input-otp";
import { Spinner } from "@relay/ui/ui/spinner";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  AuthFooter,
  AuthHeading,
  AuthLink,
  AuthLoading,
  authButton,
  authControl,
  FieldNote,
} from "./auth-frame";
import { authErrorMessage, safeNext, withNext } from "./auth-helpers";
import { forgetPendingEmail, readPendingEmail, rememberPendingEmail } from "./auth-options";
import { TypingInput } from "./typing-input";

const RESEND_AFTER = 30;
const CODE_LENGTH = 6;

const codeMessages: Record<string, string> = {
  INVALID_OTP: "That code isn't right. Try again.",
  OTP_EXPIRED: "That code has expired. Send a new one.",
  TOO_MANY_ATTEMPTS: "Too many wrong codes. Send a new one.",
};

/** Reads `?next=`, so render it inside a Suspense boundary. */
export function VerifyEmailWithParams() {
  return <VerifyEmail next={useSearchParams().get("next")} />;
}

/** Confirms the email with the 6-digit code sent at sign-up; a correct code also signs the person in. */
export function VerifyEmail({ next }: { next: string | null }) {
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  useEffect(() => setEmail(readPendingEmail()), []);

  if (email === undefined) return <AuthLoading />;
  if (!email) return <AskForEmail onEmail={setEmail} />;
  return <EnterCode email={email} next={next} />;
}

/** When the email isn't known in this tab (a new tab, or storage blocked). */
function AskForEmail({ onEmail }: { onEmail: (email: string) => void }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <AuthHeading
        title="Confirm your email"
        description="Enter the email you signed up with and we'll send a new code."
      />
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={async (event) => {
          event.preventDefault();
          const email = value.trim().toLowerCase();
          if (!/^\S+@\S+\.\S+$/.test(email)) {
            setError("Enter an email like name@business.com.");
            return;
          }
          setSending(true);
          await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" });
          rememberPendingEmail(email);
          onEmail(email);
        }}
      >
        <Field data-invalid={!!error || undefined} className="gap-2">
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <TypingInput
            id="email"
            type="email"
            autoComplete="email"
            className={authControl}
            value={value}
            aria-invalid={!!error || undefined}
            onChange={(e) => setValue(e.target.value)}
          />
          <FieldNote error={error} />
        </Field>
        <Button type="submit" className={authButton} disabled={sending}>
          {sending ? <Spinner /> : null}
          Send code
        </Button>
      </form>
    </>
  );
}

function EnterCode({ email, next }: { email: string; next: string | null }) {
  const router = useRouter();
  const target = safeNext(next, "/onboarding");
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wait, setWait] = useState(RESEND_AFTER);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);

  async function verify(otp: string) {
    setVerifying(true);
    setError(null);
    setNotice(null);
    const { error: failed } = await authClient.emailOtp.verifyEmail({ email, otp });
    if (failed) {
      setError((failed.code && codeMessages[failed.code]) || authErrorMessage(failed));
      setCode("");
      setVerifying(false);
      return;
    }
    forgetPendingEmail();
    router.replace(target);
    router.refresh();
  }

  async function resend() {
    setError(null);
    setNotice(null);
    setWait(RESEND_AFTER);
    const { error: failed } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "email-verification",
    });
    if (failed) setError(authErrorMessage(failed));
    else setNotice("New code sent. It works for 10 minutes.");
  }

  return (
    <>
      <AuthHeading
        title="Check your email"
        description={
          <>
            We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>. Enter it
            below to confirm your account.
          </>
        }
      />
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.length === CODE_LENGTH) void verify(code);
        }}
      >
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor="code" className="sr-only">
            6-digit code
          </FieldLabel>
          <InputOTP
            id="code"
            containerClassName="justify-center"
            maxLength={CODE_LENGTH}
            pattern="^[0-9]*$"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            disabled={verifying}
            onChange={(value) => {
              setCode(value);
              if (error) setError(null);
            }}
            onComplete={(value: string) => void verify(value)}
            aria-invalid={!!error || undefined}
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} aria-invalid={!!error || undefined} />
              <InputOTPSlot index={1} aria-invalid={!!error || undefined} />
              <InputOTPSlot index={2} aria-invalid={!!error || undefined} />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={3} aria-invalid={!!error || undefined} />
              <InputOTPSlot index={4} aria-invalid={!!error || undefined} />
              <InputOTPSlot index={5} aria-invalid={!!error || undefined} />
            </InputOTPGroup>
          </InputOTP>
          <FieldNote
            className="text-center"
            error={error}
            hint={notice ?? "The code works for 10 minutes."}
            tone={notice ? "good" : "muted"}
          />
        </Field>
        <Button
          type="submit"
          size="lg"
          className="w-full text-[15px]"
          disabled={verifying || code.length < CODE_LENGTH}
        >
          {verifying ? (
            <>
              <Spinner />
              Confirming
            </>
          ) : (
            "Confirm email"
          )}
        </Button>
      </form>
      <AuthFooter>
        <p>
          Didn't get it?{" "}
          {wait > 0 ? (
            <span>Send a new code in {wait}s</span>
          ) : (
            <button
              type="button"
              onClick={resend}
              className="rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Send a new code
            </button>
          )}
        </p>
        <p className="mt-1">
          Wrong email?{" "}
          <AuthLink href={withNext("/sign-up", next && target === next ? next : null)}>Start again</AuthLink>
        </p>
      </AuthFooter>
    </>
  );
}
