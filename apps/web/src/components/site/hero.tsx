"use client";

import { Icon } from "@relay/ui/components/icon";
import { cn } from "@relay/ui/lib/utils";
import { Button } from "@relay/ui/ui/button";
import Link from "next/link";
import { FloatingCard } from "@/components/account/showcase/parts";
import { fade, useRotation } from "@/components/account/showcase/rotation";
import { slides } from "@/components/account/showcase/slides";
import { ProductFrame } from "./product-frame";

const SLIDE_MS = 6000;

/** The first screen: the promise, two buttons, and the product turning through its three views. */
export function Hero() {
  const { index, setIndex, hover } = useRotation(slides.length, SLIDE_MS);

  return (
    <section className="mx-auto flex max-w-[1200px] flex-col items-center px-4 pt-16 text-center sm:px-6 md:pt-24">
      <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[12px] text-white/80">
        <span className="size-1.5 rounded-full bg-[#4ade80]" />
        Built on the official WhatsApp Business Platform
      </span>
      <h1 className="mt-6 max-w-[860px] text-[36px] leading-[42px] font-semibold tracking-[-0.035em] text-balance sm:text-[48px] sm:leading-[54px] lg:text-[60px] lg:leading-[66px]">
        The inbox where your AI agent and your team work as one.
      </h1>
      <p className="mt-5 max-w-[620px] text-[16px] leading-7 text-pretty text-white/70 sm:text-[18px]">
        WhatsApp, Instagram and website chats for every branch. Mira answers the routine questions, books
        appointments and follows up, and your team takes the chats that need a person.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg" className="bg-white text-[#1c0f45] hover:bg-white/90">
          <Link href="/sign-up">
            Get started free
            <Icon name="arrowRight" size="sm" />
          </Link>
        </Button>
        <Button
          asChild
          size="lg"
          variant="ghost"
          className="border border-white/20 text-white hover:bg-white/10 hover:text-white"
        >
          <Link href="/#how">See how it works</Link>
        </Button>
      </div>

      <div className="mt-14 w-full md:mt-20" {...hover}>
        {/* Which view is showing; also lets people jump to one. */}
        <div
          role="tablist"
          aria-label="Product views"
          className="mb-4 inline-flex rounded-full border border-white/15 bg-white/5 p-1"
        >
          {slides.map((slide, i) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              onClick={() => setIndex(i)}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                i === index ? "bg-white text-[#1c0f45]" : "text-white/70 hover:text-white",
              )}
            >
              {slide.label}
            </button>
          ))}
        </div>

        <div className="relative text-left">
          <ProductFrame className="h-[420px] sm:h-[520px] lg:h-[600px]">
            {slides.map((slide, i) => (
              <div
                key={slide.id}
                aria-hidden
                className={cn("absolute inset-0", fade(i === index, "translate-y-1"))}
              >
                {slide.window}
              </div>
            ))}
          </ProductFrame>
          <div className="absolute -bottom-6 left-3 grid sm:left-[-24px] sm:bottom-10">
            {slides.map((slide, i) => (
              <div
                key={slide.id}
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
