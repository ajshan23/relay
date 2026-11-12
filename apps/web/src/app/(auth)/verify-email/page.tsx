import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthLoading } from "@/components/account/auth-frame";
import { VerifyEmailWithParams } from "@/components/account/verify-email";

export const metadata: Metadata = { title: "Confirm your email · Relay" };

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<AuthLoading />}>
      <VerifyEmailWithParams />
    </Suspense>
  );
}
