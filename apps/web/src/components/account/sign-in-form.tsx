"use client";

import { Icon } from "@relay/ui/components/icon";
import { Button } from "@relay/ui/ui/button";
import { Field, FieldLabel } from "@relay/ui/ui/field";
import { Spinner } from "@relay/ui/ui/spinner";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signIn } from "@/lib/auth-client";
import { AuthHeading, AuthLink, AuthSwitch, authButton, authControl, FieldNote } from "./auth-frame";
import { authErrorMessage, safeNext, withNext } from "./auth-helpers";
import { rememberPendingEmail } from "./auth-options";
import { PasswordField } from "./password-field";
import { PasswordChangedNotice } from "./password-reset";
import { SocialButtons } from "./social-buttons";
import { TypingInput } from "./typing-input";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads `?next=` and `?error=`, so render it inside a Suspense boundary. */
export function SignInWithParams() {
  const params = useSearchParams();
  return (
    <SignInForm
      next={params.get("next")}
      googleFailed={params.get("error") === "google"}
      passwordChanged={params.get("reset") === "1"}
    />
  );
}

/**
 * Sign in, one question at a time: email first, then password, the way Clerk and Vercel do it.
 * Nothing is sent to the server until the password step, so the email step never reveals
 * whether an account exists. Goes to `next` (a same-site path) or Today.
 */
export function SignInForm({
  next,
  googleFailed = false,
  passwordChanged = false,
}: {
  next: string | null;
  googleFailed?: boolean;
  passwordChanged?: boolean;
}) {
  const router = useRouter();
  const target = safeNext(next, "/today");
  const keepNext = target === next ? next : null;

  const [step, setStep] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(
    googleFailed ? "Google sign-in didn't finish. Try again, or use your email." : null,
  );
  const [pending, setPending] = useState(false);
  const [showChanged, setShowChanged] = useState(passwordChanged);
  const passwordRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "password") passwordRef.current?.focus();
    else emailRef.current?.focus();
  }, [step]);

  function continueWithEmail(event: React.FormEvent) {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!value) return setEmailError("Enter your email address.");
    if (!emailPattern.test(value)) return setEmailError("Enter an email like name@business.com.");
    setEmail(value);
    setEmailError(null);
    setServerError(null);
    setStep("password");
  }

  async function signInWithPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!password) return setPasswordError("Enter your password.");
    setPasswordError(null);
    setServerError(null);
    setPending(true);
    setShowChanged(false);
    const { error } = await signIn.email({ email, password, callbackURL: target });
    if (!error) {
      router.replace(target);
      router.refresh();
      return;
    }
    setPending(false);
    if (error.code === "EMAIL_NOT_VERIFIED") {
      // The server has just sent a fresh code (emailVerification.sendOnSignIn); finish the sign-up there.
      rememberPendingEmail(email);
      router.push(withNext("/verify-email", keepNext));
      return;
    }
    setServerError(authErrorMessage(error));
    setPassword("");
    passwordRef.current?.focus();
  }

  return (
    <>
      {/* Each step rises in when it changes, inside the card that glides to its new height. */}
      <div key={step} className="flex animate-rise-in flex-col gap-6 motion-reduce:animate-none">
        <AuthHeading
          title={step === "email" ? "Sign in to Relay" : "Enter your password"}
          description={step === "email" ? "Welcome back. Sign in to continue." : null}
        />

        {step === "email" ? (
          <div className="flex flex-col gap-6">
            {showChanged ? <PasswordChangedNotice /> : null}
            <SocialButtons next={target} disabled={pending} />
            <form noValidate onSubmit={continueWithEmail} className="flex flex-col gap-3">
              <Field data-invalid={!!emailError || undefined} className="gap-2">
                <FieldLabel htmlFor="email">Email address</FieldLabel>
                <TypingInput
                  ref={emailRef}
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  className={authControl}
                  value={email}
                  aria-invalid={!!emailError || undefined}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError(null);
                  }}
                />
                <FieldNote error={emailError ?? serverError} />
              </Field>
              <Button type="submit" className={authButton}>
                Continue
                <Icon name="chevronRight" size="sm" />
              </Button>
            </form>
          </div>
        ) : (
          <form noValidate onSubmit={signInWithPassword} className="flex flex-col gap-3">
            <div className="-mt-3 mb-2 flex items-center justify-center">
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setPassword("");
                  setPasswordError(null);
                  setServerError(null);
                }}
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-border px-3 py-1 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={`Signing in as ${email}. Change email`}
              >
                <span className="truncate">{email}</span>
                <Icon name="edit" size="xs" className="shrink-0 text-muted-foreground" />
              </button>
            </div>
            {/* Lets password managers pair the saved password with this email. */}
            <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
            <Field data-invalid={!!(passwordError || serverError) || undefined} className="gap-2">
              <div className="flex items-center">
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <span className="ml-auto text-[13px]">
                  <AuthLink href="/forgot-password">Forgot password?</AuthLink>
                </span>
              </div>
              <PasswordField
                ref={passwordRef}
                id="password"
                name="password"
                autoComplete="current-password"
                disabled={pending}
                invalid={!!(passwordError || serverError)}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError) setPasswordError(null);
                  if (serverError) setServerError(null);
                }}
              />
              <FieldNote error={passwordError ?? serverError} />
            </Field>
            <Button type="submit" className={authButton} disabled={pending}>
              {pending ? (
                <>
                  <Spinner />
                  Signing in
                </>
              ) : (
                <>
                  Sign in
                  <Icon name="chevronRight" size="sm" />
                </>
              )}
            </Button>
          </form>
        )}
      </div>
      <AuthSwitch prompt="Don't have an account?" href={withNext("/sign-up", keepNext)} label="Sign up" />
    </>
  );
}
