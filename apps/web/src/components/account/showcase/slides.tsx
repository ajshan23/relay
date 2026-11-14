import type { IconName } from "@relay/ui/components/icon";
import type { ReactNode } from "react";
import { AgentWindow } from "./agent-window";
import { CampaignWindow } from "./campaign-window";
import { InboxWindow } from "./inbox-window";

/* The three views of the product shown beside sign-in and on the landing page. */

export type Slide = {
  id: "inbox" | "agent" | "campaigns";
  label: string;
  title: string;
  body: string;
  window: ReactNode;
  card: { icon: IconName; tone?: "ai" | "good"; title: string; body: string };
};

export const slides: Slide[] = [
  {
    id: "inbox",
    label: "Inbox",
    title: "The inbox where your AI agent and your team work as one.",
    body: "WhatsApp, Instagram and website chats for every branch. Mira answers the routine questions; your team gets the ones that need a person.",
    window: <InboxWindow />,
    card: {
      icon: "sparkles",
      title: "Mira booked an appointment",
      body: "Hana Yousef, cleaning, tomorrow at 9:30. No one needed.",
    },
  },
  {
    id: "agent",
    label: "AI agent",
    title: "Teach Mira once. She answers like your best receptionist.",
    body: "She learns from your website, price list and opening hours, shows where each answer came from, and only does what you allow.",
    window: <AgentWindow />,
    card: {
      icon: "check",
      tone: "good",
      title: "142 chats resolved by Mira this week",
      body: "Bookings, prices and opening hours, answered in seconds.",
    },
  },
  {
    id: "campaigns",
    label: "Campaigns",
    title: "Campaigns that bring customers back, not spam.",
    body: "Send Meta-approved WhatsApp messages to the right people, and let Mira handle the replies as they come in.",
    window: <CampaignWindow />,
    card: {
      icon: "calendar",
      tone: "good",
      title: "38 appointments from one campaign",
      body: "Check-up reminder, sent this morning to patients not seen in 6 months.",
    },
  },
];
