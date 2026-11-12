"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * The inside of the auth card. When the screen changes (sign in ↔ sign up, or a step inside one),
 * the card's height glides to the new size and the new content rises in, instead of snapping.
 */
export function CardBody({ logo, children }: { logo: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      style={{ height: height ?? undefined }}
      className="overflow-hidden transition-[height] duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
    >
      <div ref={inner} className="flex flex-col gap-6 px-6 pt-8 pb-7 sm:px-9">
        {logo}
        <div key={pathname} className="flex animate-rise-in flex-col gap-6 motion-reduce:animate-none">
          {children}
        </div>
      </div>
    </div>
  );
}
