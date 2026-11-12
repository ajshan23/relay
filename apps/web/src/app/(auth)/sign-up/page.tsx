import type { Metadata } from "next";
import { Suspense } from "react";
import { SignUpForm, SignUpWithParams } from "@/components/account/sign-up-form";

export const metadata: Metadata = { title: "Create your account · Relay" };

export default function SignUpPage() {
  return (
    <Suspense fallback={<SignUpForm next={null} />}>
      <SignUpWithParams />
    </Suspense>
  );
}
