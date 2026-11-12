import type { ReactNode } from "react";
import { AuthFrame } from "@/components/account/auth-frame";

/** Signed-out screens: sign in, create an account, confirm email, reset a password, accept an invitation. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthFrame>{children}</AuthFrame>;
}
