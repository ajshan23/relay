import type { Metadata } from "next";
import { Faq } from "@/components/site/faq";
import { Hero } from "@/components/site/hero";
import { Channels, ClosingCta, FeatureRows, HowItWorks } from "@/components/site/sections";

export const metadata: Metadata = {
  title: "Relay · WhatsApp inbox with an AI agent for your business",
  description:
    "One inbox for WhatsApp and more, for every branch. Mira, your AI agent, answers routine questions and books appointments; your team handles the rest; campaigns bring customers back.",
  openGraph: {
    title: "Relay · WhatsApp inbox with an AI agent",
    description: "The inbox where your AI agent and your team work as one.",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
};

export default function Home() {
  return (
    <>
      <Hero />
      <FeatureRows />
      <Channels />
      <HowItWorks />
      <Faq />
      <ClosingCta />
    </>
  );
}
