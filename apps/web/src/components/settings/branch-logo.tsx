"use client";

import { cn } from "@relay/ui/lib/utils";

/** A branch's logo, or its first letter on a soft square when it has none. */
export function BranchLogo({
  branch,
  size = "md",
  className,
}: {
  branch: { name: string; logoUrl: string | null };
  size?: "xs" | "md" | "lg";
  className?: string;
}) {
  const box = {
    xs: "size-4 rounded-sm text-[9px]",
    md: "size-7 rounded-md text-xs",
    lg: "size-16 rounded-lg text-xl",
  }[size];
  if (branch.logoUrl)
    return (
      // biome-ignore lint/performance/noImgElement: a small private image served by the API, not a page asset
      <img
        src={branch.logoUrl}
        alt=""
        className={cn(box, "shrink-0 border bg-background object-contain", className)}
      />
    );
  return (
    <span
      aria-hidden
      className={cn(
        box,
        "inline-flex shrink-0 items-center justify-center bg-accent font-semibold text-accent-foreground",
        className,
      )}
    >
      {branch.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
