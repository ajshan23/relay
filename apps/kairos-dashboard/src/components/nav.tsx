"use client";

import { CalendarClock, HeartPulse, LayoutDashboard, ListTree, Radio, Server } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { KairosMark } from "./theme";

const items = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/runs", label: "Runs", icon: ListTree },
  { href: "/upcoming", label: "Upcoming", icon: CalendarClock },
  { href: "/events", label: "Events", icon: Radio },
  { href: "/workers", label: "Workers", icon: Server },
  { href: "/health", label: "Health", icon: HeartPulse },
];

export function Nav({ row = false }: { row?: boolean }) {
  const path = usePathname();
  return (
    <nav className={cn("flex gap-0.5", row ? "flex-row" : "flex-col")} aria-label="Kairos">
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] text-nav-muted transition-colors hover:text-nav-foreground",
              active && "bg-nav-active font-medium text-nav-foreground shadow-elevated",
            )}
          >
            <Icon
              className={cn(
                "size-4 transition-colors",
                active ? "text-primary" : "text-nav-muted group-hover:text-nav-foreground",
              )}
              aria-hidden
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2">
      <KairosMark className="size-7" />
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-semibold tracking-tight">Kairos</span>
        <span className="mt-1 text-[11px] text-nav-muted">Durable runs</span>
      </span>
    </Link>
  );
}
