"use client";

import { cn } from "@relay/ui/lib/utils";
import { BrandBackdrop } from "@/components/site/brand-backdrop";
import { FloatingCard } from "./showcase/parts";
import { fade, useRotation } from "./showcase/rotation";
import { slides } from "./showcase/slides";

/*
 * The panel beside the sign-in card: the product itself, in three slides that turn on their own
 * (the inbox, Mira, campaigns), changing with one soft cross-fade, with no indicator.
 * Pauses while the pointer is over it, and stays on the first slide when motion is reduced.
 * The app window's frame never moves, so it reads as the app changing view rather than one
 * picture replacing another.
 */

const SLIDE_MS = 6000;

export function ProductPanel({ variant = "product" }: { variant?: "product" | "onboarding" }) {
  const { index, hover } = useRotation(slides.length, SLIDE_MS);

  return (
    <section
      aria-roledescription="carousel"
      aria-label="What Relay does"
      {...hover}
      className="relative h-full overflow-hidden bg-[#1c0f45] text-white"
    >
      <BrandBackdrop />

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
