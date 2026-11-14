"use client";

import { Icon } from "@relay/ui/components/icon";
import { Button } from "@relay/ui/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@relay/ui/ui/sheet";
import Link from "next/link";
import { useState } from "react";
import { RelayMark } from "@/components/account/auth-frame";
import { useSession } from "@/lib/auth-client";
import { nav } from "./site";

/** Sticky top bar: the logo, section links, and sign-in or "Open Relay" for people already signed in. */
export function SiteHeader() {
  const { data: session, isPending } = useSession();
  const [open, setOpen] = useState(false);
  const signedIn = !isPending && !!session;

  const actions = signedIn ? (
    <Button asChild size="sm" className="bg-white text-[#1c0f45] hover:bg-white/90">
      <Link href="/today">
        Open Relay
        <Icon name="arrowRight" size="sm" />
      </Link>
    </Button>
  ) : (
    <>
      <Button asChild size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white">
        <Link href="/sign-in">Sign in</Link>
      </Button>
      <Button asChild size="sm" className="bg-white text-[#1c0f45] hover:bg-white/90">
        <Link href="/sign-up">Get started</Link>
      </Button>
    </>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#1c0f45]/75 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-8 px-4 sm:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 rounded-[8px] text-[17px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <RelayMark className="[&_path]:stroke-white" />
          Relay
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-6 text-[14px] text-white/70 md:flex">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="transition-colors hover:text-white">
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-2 md:flex">{actions}</div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Open menu"
              className="ml-auto text-white hover:bg-white/10 hover:text-white md:hidden"
            >
              <Icon name="menu" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[280px] border-white/10 bg-[#1c0f45] p-6 text-white">
            <SheetTitle className="text-white">Menu</SheetTitle>
            <nav aria-label="Main" className="mt-2 flex flex-col gap-1 text-[15px]">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2 py-2 text-white/80 hover:bg-white/10 hover:text-white"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="mt-6 flex flex-col gap-2 [&>a]:w-full">{actions}</div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
