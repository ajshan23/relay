"use client";

import { useZodForm } from "@relay/ui/components/form";
import { Icon } from "@relay/ui/components/icon";
import { Button } from "@relay/ui/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@relay/ui/ui/field";
import { Spinner } from "@relay/ui/ui/spinner";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { signUp } from "@/lib/auth-client";
import {
  AuthError,
  AuthHeading,
  AuthLink,
  AuthSwitch,
  authButton,
  authControl,
  FieldNote,
} from "./auth-frame";
import { authErrorMessage, safeNext, withNext } from "./auth-helpers";
import { rememberPendingEmail, useAuthOptions } from "./auth-options";
import { PasswordField, passwordStrength, StrengthMeter } from "./password-field";
import { SocialButtons } from "./social-buttons";
import { TypingInput } from "./typing-input";

/** Reads `?next=`, so render it inside a Suspense boundary. */
export function SignUpWithParams() {
  return <SignUpForm next={useSearchParams().get("next")} />;
}

/**
 * Create an account (shadcn signup-02 layout). After submitting, the person confirms their
 * email with a 6-digit code, then goes to `next` (for example an invitation) or onboarding.
 */
export function SignUpForm({ next }: { next: string | null }) {
  const router = useRouter();
  const { passwordMinLength: min } = useAuthOptions();
  const target = safeNext(next, "/onboarding");
  const keepNext = target === next ? next : null;
  const [serverError, setServerError] = useState<string | null>(null);

  const schema = z.object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Enter your work email.")
      .email("Enter an email like name@business.com."),
    password: z.string().min(min, `Use at least ${min} characters.`).max(128, "Use 128 characters or fewer."),
  });
  const form = useZodForm(schema, {
    defaultValues: { email: "", password: "" },
    mode: "onTouched",
  });
  const { errors, isSubmitting } = form.formState;
  const [email, password] = form.watch(["email", "password"]);
  const strength = passwordStrength(password, min, [email.split("@")[0] ?? ""]);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    // The name is asked for in onboarding; until then the account uses the start of the email.
    const name = values.email.split("@")[0] ?? values.email;
    const { error } = await signUp.email({ ...values, name, callbackURL: target });
    if (error) {
      if (error.code === "USER_ALREADY_EXISTS" || error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        form.setError("email", { message: "An account with this email already exists." });
        return;
      }
      setServerError(authErrorMessage(error));
      return;
    }
    rememberPendingEmail(values.email);
    router.push(withNext("/verify-email", keepNext));
  });

  return (
    <>
      <AuthHeading title="Create your account" description="It only takes a minute." />
      <div className="flex flex-col gap-5">
        <SocialButtons next={target} disabled={isSubmitting} />
        <form noValidate onSubmit={onSubmit} className="flex flex-col">
          <FieldGroup className="gap-2.5">
            <Field data-invalid={!!errors.email || undefined} className="gap-2">
              <FieldLabel htmlFor="email">Email address</FieldLabel>
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
              <FieldNote error={errors.email?.message} />
            </Field>
            <Field data-invalid={!!errors.password || undefined} className="gap-2">
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <PasswordField
                id="password"
                autoComplete="new-password"
                disabled={isSubmitting}
                invalid={!!errors.password}
                {...form.register("password")}
              />
              <StrengthMeter
                strength={strength}
                error={errors.password && !password ? errors.password.message : undefined}
              />
            </Field>
            <AuthError>{serverError}</AuthError>
            <Field className="mt-1 gap-2.5">
              <Button type="submit" className={authButton} disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner />
                    Creating your account
                  </>
                ) : (
                  <>
                    Continue
                    <Icon name="chevronRight" size="sm" />
                  </>
                )}
              </Button>
              <FieldDescription className="text-center text-[12px] leading-[18px] text-balance">
                By continuing you agree to the <AuthLink href="/terms">Terms</AuthLink> and{" "}
                <AuthLink href="/privacy">Privacy Policy</AuthLink>.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      </div>
      <AuthSwitch prompt="Already have an account?" href={withNext("/sign-in", keepNext)} label="Sign in" />
    </>
  );
}
