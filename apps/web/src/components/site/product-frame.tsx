import { cn } from "@relay/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * The app window on the landing page: a rounded frame with a soft glow. The view inside keeps a
 * desktop width and is cropped on small screens rather than squeezed, so it always reads as the app.
 */
export function ProductFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[14px] border border-white/20 bg-background shadow-[0_30px_80px_-20px_rgb(10_4_30/0.7)]",
        className,
      )}
    >
      <div className="absolute inset-y-0 left-0 w-full min-w-[880px]">{children}</div>
    </div>
  );
}
