import Link from "next/link";
import type { ReactNode } from "react";
import { RelayMark } from "@/components/account/auth-frame";

/** Plain reading layout for the legal pages. */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background px-6 text-foreground sm:px-10">
      <header className="flex h-20 items-center">
        <Link href="/sign-in" className="inline-flex items-center gap-2.5 text-[17px] font-semibold">
          <RelayMark />
          Relay
        </Link>
      </header>
      <main className="mx-auto flex max-w-[640px] flex-col gap-4 py-10 text-[15px] leading-7">
        {children}
      </main>
    </div>
  );
}
