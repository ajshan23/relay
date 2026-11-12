import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthLoading } from "@/components/account/auth-frame";
import { ResetPasswordWithParams } from "@/components/account/password-reset";

export const metadata: Metadata = { title: "Choose a new password · Relay" };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthLoading />}>
      <ResetPasswordWithParams />
    </Suspense>
  );
}
