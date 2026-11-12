import type { ReactNode } from "react";

/** Onboarding draws its own frame, because its preview follows what is typed in the form. */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return children;
}
