import type { Metadata } from "next";
import { Onboarding } from "@/components/account/onboarding";

export const metadata: Metadata = { title: "Set up your business · Relay" };

export default function OnboardingPage() {
  return <Onboarding />;
}
