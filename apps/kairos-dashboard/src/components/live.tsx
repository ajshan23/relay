"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Refreshes the page's data every few seconds while it's visible, and says when it last did. */
export function Live({ every = 10_000 }: { every?: number }) {
  const router = useRouter();
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    setAt(new Date());
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
      setAt(new Date());
    }, every);
    return () => clearInterval(t);
  }, [router, every]);
  return (
    <span className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground shadow-elevated">
      <span className="kairos-breathe size-1.5 rounded-full bg-primary" aria-hidden />
      {at
        ? `Live, updated ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
        : "Live"}
    </span>
  );
}
