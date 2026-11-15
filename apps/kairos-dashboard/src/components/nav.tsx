"use client";

import { Activity, CalendarClock, Gauge, HeartPulse, ListTree, Radio, Server } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/runs", label: "Runs", icon: ListTree },
  { href: "/upcoming", label: "Upcoming", icon: CalendarClock },
  { href: "/events", label: "Events", icon: Radio },
  { href: "/workers", label: "Workers", icon: Server },
  { href: "/health", label: "Health", icon: HeartPulse },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Kairos">
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-nav-muted transition-colors hover:bg-nav-active hover:text-nav-foreground",
              active && "bg-nav-active font-medium text-nav-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 px-2.5 py-1">
      <span className="inline-flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Activity className="size-4" aria-hidden />
      </span>
      <span className="text-sm font-semibold tracking-tight">Kairos</span>
    </Link>
  );
}
