"use client";

import type { IconName } from "@relay/ui/components/icon";
import { cn } from "@relay/ui/lib/utils";
import { type ReactNode, useEffect, useState } from "react";
import { AgentWindow } from "./showcase/agent-window";
import { CampaignWindow } from "./showcase/campaign-window";
import { InboxWindow } from "./showcase/inbox-window";
import { FloatingCard } from "./showcase/parts";

/*
 * The panel beside the sign-in card: the product itself, in three slides that turn on their own
 * (the inbox, Mira, campaigns), changing with one soft cross-fade, with no indicator.
 * Pauses while the pointer is over it, and stays on the first slide when motion is reduced.
 */

const SLIDE_MS = 6000;

type Slide = {
  label: string;
  title: string;
  body: string;
  window: ReactNode;
  card: { icon: IconName; tone?: "ai" | "good"; title: string; body: string };
};

const slides: Slide[] = [
  {
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

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/*
 * The change between slides: one soft cross-fade. The old view eases out while the new one eases
 * in with a few pixels of lift. The app window's frame never moves, so it reads as the app changing
 * view rather than one picture replacing another. Only opacity and transform animate (no blur),
 * which the browser can run on the GPU.
 */
const fade = (on: boolean, lift: string) =>
  cn(
    "transition-[opacity,transform] will-change-[opacity,transform] motion-reduce:transition-none",
    on
      ? "translate-y-0 opacity-100 duration-[1000ms] delay-200 ease-[cubic-bezier(0.65,0,0.35,1)]"
      : `pointer-events-none ${lift} opacity-0 duration-[450ms] ease-[cubic-bezier(0.33,1,0.68,1)]`,
  );

export function ProductPanel({ variant = "product" }: { variant?: "product" | "onboarding" }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const autoplay = !paused && !reducedMotion;

  useEffect(() => {
    if (!autoplay) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % slides.length), SLIDE_MS);
    return () => window.clearInterval(timer);
  }, [autoplay]);

  return (
    <section
      aria-roledescription="carousel"
      aria-label="What Relay does"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="relative h-full overflow-hidden bg-[#1c0f45] text-white"
    >
      {/* Brand light: a violet glow from the top right and a soft wash behind the product. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_70%_at_100%_0%,#7c4dff_0%,transparent_60%),radial-gradient(80%_60%_at_20%_110%,#4b23b8_0%,transparent_65%)] opacity-90"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:linear-gradient(white_1px,transparent_1px),linear-gradient(90deg,white_1px,transparent_1px)] [background-size:48px_48px] [mask-image:linear-gradient(to_bottom,black,transparent_55%)]"
      />

      <div className="relative flex h-full flex-col">
        {/* Headlines, stacked in one place. */}
        <div className="grid px-12 pt-16 xl:px-16 xl:pt-20">
          {slides.map((slide, i) => (
            <section
              key={slide.label}
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${slides.length}: ${slide.label}`}
              aria-hidden={i !== index}
              className={cn("flex flex-col gap-4 [grid-area:1/1]", fade(i === index, "-translate-y-1"))}
            >
              <h2 className="max-w-[520px] text-[28px] leading-[34px] font-semibold tracking-[-0.03em] text-balance xl:text-[34px] xl:leading-[40px]">
                {variant === "onboarding" && i === 0
                  ? "Mira starts answering once WhatsApp is connected."
                  : slide.title}
              </h2>
              <p className="max-w-[470px] text-[15px] leading-6 text-pretty text-white/70">{slide.body}</p>
            </section>
          ))}
        </div>

        <div className="relative mt-12 min-h-0 flex-1">
          {/* The app window: one still frame; only the view inside it changes. */}
          <div className="absolute top-0 right-0 bottom-0 left-12 overflow-hidden rounded-tl-[14px] border-t border-l border-white/25 bg-background shadow-[0_30px_80px_-20px_rgb(10_4_30/0.6)] xl:left-16">
            {slides.map((slide, i) => (
              <div
                key={slide.label}
                aria-hidden
                className={cn("absolute inset-0", fade(i === index, "translate-y-1"))}
              >
                {slide.window}
              </div>
            ))}
          </div>

          {/* Floating cards, stacked in one place. */}
          <div className="absolute bottom-10 left-6 grid xl:left-8">
            {slides.map((slide, i) => (
              <div
                key={slide.label}
                aria-hidden
                className={cn("[grid-area:1/1]", fade(i === index, "translate-y-1.5"))}
              >
                <FloatingCard {...slide.card} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
