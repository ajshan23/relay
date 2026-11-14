import { Icon, type IconName } from "@relay/ui/components/icon";
import { cn } from "@relay/ui/lib/utils";
import { Button } from "@relay/ui/ui/button";
import Link from "next/link";
import { FloatingCard } from "@/components/account/showcase/parts";
import { slides } from "@/components/account/showcase/slides";
import { ProductFrame } from "./product-frame";

/* The landing page's sections below the hero, all on the dark violet brand page. */

function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-[13px] font-medium tracking-[0.02em] text-[#b39bff]">{eyebrow}</span>
      <h2 className="text-[28px] leading-[34px] font-semibold tracking-[-0.03em] text-balance sm:text-[36px] sm:leading-[42px]">
        {title}
      </h2>
      {body ? <p className="text-[16px] leading-7 text-pretty text-white/70">{body}</p> : null}
    </div>
  );
}

const points: Record<(typeof slides)[number]["id"], string[]> = {
  inbox: [
    "Every WhatsApp, Instagram and website chat in one list, for each branch.",
    "When Mira hands a chat over, she writes a summary, so no one asks twice.",
    "Assign, tag and reply with quick replies and approved templates.",
  ],
  agent: [
    "Learns from your website, price list and opening hours.",
    "Shows where each answer came from, so you can check her work.",
    "Books appointments, and hands over to a person when she's unsure.",
  ],
  campaigns: [
    "Meta-approved templates, filled in with each customer's name and details.",
    "Sends at a safe pace, only in the hours you choose.",
    "Follows up with people who didn't read it, and tests two messages to find the better one.",
  ],
};

/** One row per product view: words on one side, the app window on the other, alternating. */
export function FeatureRows() {
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-24 px-4 py-24 sm:px-6 md:gap-32 md:py-32">
      {slides.map((slide, i) => (
        <section
          key={slide.id}
          id={slide.id}
          className="grid scroll-mt-24 items-center gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16"
        >
          <div className={cn("flex flex-col gap-6", i % 2 === 1 && "lg:order-2")}>
            <SectionHeading
              eyebrow={slide.label}
              title={slide.id === "inbox" ? "Every chat, every branch, one inbox." : slide.title}
              body={slide.body}
            />
            <ul className="flex flex-col gap-3">
              {points[slide.id].map((point) => (
                <li key={point} className="flex gap-3 text-[15px] leading-6 text-white/80">
                  <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[#b39bff]">
                    <Icon name="check" size="xs" />
                  </span>
                  {point}
                </li>
              ))}
            </ul>
          </div>
          <div className="relative pb-8 lg:pb-0">
            <ProductFrame className="h-[380px] sm:h-[460px]">{slide.window}</ProductFrame>
            <div
              className={cn(
                "absolute -bottom-2 left-3 sm:left-auto sm:right-6 lg:bottom-8",
                i % 2 === 1 && "sm:right-auto sm:left-6",
              )}
            >
              <FloatingCard {...slide.card} />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

const channels: { icon: IconName; name: string; status: "Live" | "Coming soon" }[] = [
  { icon: "whatsapp", name: "WhatsApp", status: "Live" },
  { icon: "instagram", name: "Instagram", status: "Coming soon" },
  { icon: "conversations", name: "Messenger", status: "Coming soon" },
  { icon: "website", name: "Website chat", status: "Coming soon" },
];

/** The channels Relay connects to, honestly labelled. */
export function Channels() {
  return (
    <section className="border-y border-white/10 bg-white/[0.03]">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
        <p className="max-w-[300px] text-[18px] leading-7 font-semibold tracking-[-0.02em]">
          One inbox for the places your customers already write to you.
        </p>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:gap-4">
          {channels.map((channel) => (
            <li
              key={channel.name}
              className="flex flex-col items-start gap-3 rounded-[12px] border border-white/10 bg-white/5 p-4 md:w-[170px]"
            >
              <span className="inline-flex size-9 items-center justify-center rounded-[10px] bg-white/10">
                <Icon name={channel.icon} />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium">{channel.name}</span>
                <span
                  className={cn(
                    "text-[12px]",
                    channel.status === "Live" ? "text-[#4ade80]" : "text-white/50",
                  )}
                >
                  {channel.status}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const steps: { title: string; body: string }[] = [
  {
    title: "Connect WhatsApp in a few minutes",
    body: "Sign in with Facebook, pick your business and number, and Relay is connected. No code, no waiting on a partner.",
  },
  {
    title: "Teach Mira your business",
    body: "Point her at your website, prices and opening hours. Decide what she may do on her own and when she hands over.",
  },
  {
    title: "Answer, and bring customers back",
    body: "Your team works the inbox with Mira, and campaigns remind customers when it's time to come back.",
  },
];

/** Three steps from sign-up to the first answered chat. */
export function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-[1200px] scroll-mt-24 px-4 py-24 sm:px-6 md:py-32">
      <div className="max-w-[640px]">
        <SectionHeading eyebrow="How it works" title="From sign-up to answered chats on the same day." />
      </div>
      <ol className="mt-12 grid gap-4 md:grid-cols-3">
        {steps.map((step, i) => (
          <li
            key={step.title}
            className="flex flex-col gap-4 rounded-[14px] border border-white/10 bg-white/5 p-6"
          >
            <span className="inline-flex size-8 items-center justify-center rounded-full bg-white text-[14px] font-semibold text-[#1c0f45]">
              {i + 1}
            </span>
            <h3 className="text-[18px] leading-6 font-semibold tracking-[-0.02em]">{step.title}</h3>
            <p className="text-[15px] leading-6 text-white/70">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The last push before the footer. */
export function ClosingCta() {
  return (
    <section className="mx-auto max-w-[1200px] px-4 pb-24 sm:px-6">
      <div className="relative overflow-hidden rounded-[20px] border border-white/15 bg-[radial-gradient(80%_120%_at_100%_0%,#7c4dff_0%,transparent_60%),radial-gradient(70%_100%_at_0%_100%,#4b23b8_0%,transparent_65%)] px-6 py-14 text-center sm:px-12 md:py-20">
        <h2 className="mx-auto max-w-[640px] text-[30px] leading-[36px] font-semibold tracking-[-0.03em] text-balance sm:text-[40px] sm:leading-[46px]">
          Start answering customers on WhatsApp today.
        </h2>
        <p className="mx-auto mt-4 max-w-[480px] text-[16px] leading-7 text-white/75">
          Set up takes minutes. Mira starts helping as soon as your number is connected.
        </p>
        <div className="mt-8 flex justify-center">
          <Button asChild size="lg" className="bg-white text-[#1c0f45] hover:bg-white/90">
            <Link href="/sign-up">
              Get started free
              <Icon name="arrowRight" size="sm" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
