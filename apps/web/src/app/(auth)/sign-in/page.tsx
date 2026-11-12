import type { Metadata } from "next";
import { Suspense } from "react";
import { SignInForm, SignInWithParams } from "@/components/account/sign-in-form";

export const metadata: Metadata = { title: "Sign in · Relay" };

export default function SignInPage() {
  return (
    <Suspense fallback={<SignInForm next={null} />}>
      <SignInWithParams />
    </Suspense>
  );
}
