import type { ReactNode } from "react";
import { BrandBackdrop } from "@/components/site/brand-backdrop";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";

/** The public pages (home, privacy, terms, data deletion): always the dark violet brand page. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-clip bg-[#1c0f45] text-white">
      {/* The brand light sits behind the first screen only, so it doesn't stretch down a long page. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[1100px] [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
      >
        <BrandBackdrop />
      </div>
      <SiteHeader />
      <main className="relative flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
