import type { Metadata } from "next";
import { ForgotPassword } from "@/components/account/password-reset";

export const metadata: Metadata = { title: "Reset your password · Relay" };

export default function ForgotPasswordPage() {
  return <ForgotPassword />;
}
