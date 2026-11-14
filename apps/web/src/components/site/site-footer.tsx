import Link from "next/link";
import { RelayMark } from "@/components/account/auth-frame";
import { site } from "./site";

/** The footer: logo, legal links and contact. No Meta or WhatsApp logos, so nothing suggests endorsement. */
export function SiteFooter() {
  return (
    <footer className="relative border-t border-white/10">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-4 py-12 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="flex max-w-[320px] flex-col gap-3">
          <Link href="/" className="inline-flex items-center gap-2.5 text-[17px] font-semibold text-white">
            <RelayMark className="[&_path]:stroke-white" />
            {site.name}
          </Link>
          <p className="text-[13px] leading-5 text-white/55">
            Customer conversations, an AI agent and campaigns, in one inbox for every branch.
          </p>
        </div>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-white/70">
          <Link href="/privacy" className="hover:text-white">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-white">
            Terms of Service
          </Link>
          <Link href="/data-deletion" className="hover:text-white">
            Data deletion
          </Link>
          <a href={`mailto:${site.email}`} className="hover:text-white">
            Contact
          </a>
        </nav>
      </div>
      <div className="mx-auto max-w-[1200px] px-4 pb-10 text-[12px] text-white/45 sm:px-6">
        © 2026 {site.operator}. WhatsApp is a trademark of Meta Platforms, Inc.; {site.name} is not affiliated
        with or endorsed by Meta.
      </div>
    </footer>
  );
}
