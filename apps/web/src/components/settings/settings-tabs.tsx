"use client";

import { cn } from "@relay/ui/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/settings/branches", label: "Branches" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/channels", label: "Channels" },
  { href: "/settings/templates", label: "Templates" },
  { href: "/settings/quick-replies", label: "Quick replies" },
] as const;

/**
 * The tab switch under the Settings title, for phones only: wider screens use the sidebar's
 * Settings sub-menu. Built from tokens here because the design system
 * has no link-tabs component yet (Segmented is a radio group, not navigation).
 */
export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="border-b border-border px-5 sm:px-8 md:hidden">
      <ul className="-mb-px flex gap-5">
        {tabs.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center border-b-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
