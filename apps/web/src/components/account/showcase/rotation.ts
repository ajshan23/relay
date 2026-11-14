import { cn } from "@relay/ui/lib/utils";
import { useEffect, useState } from "react";

/* The slow rotation shared by the sign-in panel and the landing page's hero. */

export function usePrefersReducedMotion() {
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

/**
 * Turns through `count` views every `ms`. Pauses while the pointer is over the element that
 * spreads `hover`, and stays on the first view when motion is reduced.
 */
export function useRotation(count: number, ms: number) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const autoplay = !paused && !reducedMotion;

  useEffect(() => {
    if (!autoplay) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % count), ms);
    return () => window.clearInterval(timer);
  }, [autoplay, count, ms]);

  return {
    index,
    setIndex,
    hover: { onMouseEnter: () => setPaused(true), onMouseLeave: () => setPaused(false) },
  };
}

/*
 * The change between views: one soft cross-fade. The old view eases out while the new one eases
 * in with a few pixels of lift. Only opacity and transform animate (no blur), which the browser
 * can run on the GPU.
 */
export const fade = (on: boolean, lift: string) =>
  cn(
    "transition-[opacity,transform] will-change-[opacity,transform] motion-reduce:transition-none",
    on
      ? "translate-y-0 opacity-100 duration-[1000ms] delay-200 ease-[cubic-bezier(0.65,0,0.35,1)]"
      : `pointer-events-none ${lift} opacity-0 duration-[450ms] ease-[cubic-bezier(0.33,1,0.68,1)]`,
  );
