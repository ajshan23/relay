"use client";

import { useZodForm } from "@relay/ui/components/form";
import { Icon } from "@relay/ui/components/icon";
import { Button } from "@relay/ui/ui/button";
import { Field, FieldGroup, FieldLabel } from "@relay/ui/ui/field";
import { Spinner } from "@relay/ui/ui/spinner";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { AuthFooter, AuthHeading, AuthLink, authButton, authControl, FieldNote } from "./auth-frame";
import { authErrorMessage } from "./auth-helpers";
import { useAuthOptions } from "./auth-options";
import { PasswordField, passwordStrength, StrengthMeter } from "./password-field";
import { TypingInput } from "./typing-input";

const requestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter your email.")
    .email("Enter an email like name@business.com."),
});

/** Asks for a reset link. Always shows the same confirmation, so it never reveals who has an account. */
export function ForgotPassword() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useZodForm(requestSchema, { defaultValues: { email: "" }, mode: "onTouched" });
  const { errors, isSubmitting } = form.formState;

  if (sentTo) {
    return (
      <>
        <AuthHeading
          title="Check your email"
          description={
            <>
              If <span className="font-medium text-foreground">{sentTo}</span> has an account, a link to
              choose a new password is on its way. It works for one hour.
            </>
          }
        />
        <AuthFooter>
          <p>
            Didn't get it? Check spam, or{" "}
            <button
              type="button"
              className="rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => setSentTo(null)}
            >
              try another email
            </button>
            .
          </p>
          <p className="mt-1">
            <AuthLink href="/sign-in">Back to sign in</AuthLink>
          </p>
        </AuthFooter>
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title="Reset your password"
        description="Enter your email and we'll send you a link to choose a new password."
      />
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={form.handleSubmit(async ({ email }) => {
          setServerError(null);
          const { error } = await authClient.requestPasswordReset({
            email,
            redirectTo: `${window.location.origin}/reset-password`,
          });
          if (error?.status === 429) {
            setServerError(authErrorMessage(error));
            return;
          }
          setSentTo(email);
        })}
      >
        <FieldGroup className="gap-3">
          <Field data-invalid={!!(errors.email || serverError) || undefined} className="gap-2">
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <TypingInput
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              className={authControl}
              disabled={isSubmitting}
              aria-invalid={!!errors.email || undefined}
              {...form.register("email")}
            />
            <FieldNote error={errors.email?.message ?? serverError} />
          </Field>
          <Button type="submit" className={authButton} disabled={isSubmitting}>
            {isSubmitting ? <Spinner /> : null}
            {isSubmitting ? "Sending link" : "Send reset link"}
          </Button>
        </FieldGroup>
      </form>
      <AuthFooter>
        Remembered it? <AuthLink href="/sign-in">Back to sign in</AuthLink>
      </AuthFooter>
    </>
  );
}

/** Reads `?token=` from the emailed link, so render it inside a Suspense boundary. */
export function ResetPasswordWithParams() {
  const params = useSearchParams();
  return <ResetPassword token={params.get("token")} linkError={params.get("error")} />;
}

/** Chooses a new password from the emailed link, then goes to sign in. */
export function ResetPassword({ token, linkError }: { token: string | null; linkError: string | null }) {
  const router = useRouter();
  const { passwordMinLength: min } = useAuthOptions();
  const [serverError, setServerError] = useState<string | null>(null);
  const schema = z.object({ password: z.string().min(min, `Use at least ${min} characters.`).max(128) });
  const form = useZodForm(schema, { defaultValues: { password: "" }, mode: "onTouched" });
  const { errors, isSubmitting } = form.formState;
  const password = form.watch("password");

  if (!token || linkError) {
    return (
      <>
        <AuthHeading
          title="This link has expired"
          description="Reset links work once, for one hour. Ask for a new one and use the latest email."
        />
        <Button asChild className={authButton}>
          <a href="/forgot-password">Send a new link</a>
        </Button>
      </>
    );
  }

  return (
    <>
      <AuthHeading title="Choose a new password" description="You'll use it the next time you sign in." />
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={form.handleSubmit(async ({ password: newPassword }) => {
          setServerError(null);
          const { error } = await authClient.resetPassword({ newPassword, token });
          if (error) {
            setServerError(
              error.code === "INVALID_TOKEN"
                ? "This link has expired. Ask for a new one."
                : authErrorMessage(error),
            );
            return;
          }
          router.replace("/sign-in?reset=1");
        })}
      >
        <FieldGroup className="gap-3">
          <Field data-invalid={!!errors.password || undefined} className="gap-2">
            <FieldLabel htmlFor="password">New password</FieldLabel>
            <PasswordField
              id="password"
              autoComplete="new-password"
              autoFocus
              disabled={isSubmitting}
              invalid={!!errors.password}
              {...form.register("password")}
            />
            <StrengthMeter
              strength={passwordStrength(password, min)}
              error={
                (errors.password && !password ? errors.password.message : undefined) ??
                serverError ??
                undefined
              }
            />
          </Field>
          <Button type="submit" className={authButton} disabled={isSubmitting}>
            {isSubmitting ? <Spinner /> : null}
            {isSubmitting ? "Saving" : "Save new password"}
          </Button>
        </FieldGroup>
      </form>
    </>
  );
}

/** Shown on sign-in after a password reset. */
export function PasswordChangedNotice() {
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-md bg-good-soft px-3 py-2.5 text-[13px] text-good"
    >
      <Icon name="check" size="sm" />
      Password changed. Sign in with the new one.
    </p>
  );
}
