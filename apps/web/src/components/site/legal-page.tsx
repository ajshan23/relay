import type { ReactNode } from "react";
import { site } from "./site";

/**
 * A legal page: a title on the brand page, then the text on a light sheet so long reading is easy.
 * Children use plain h2, p and ul; this wrapper styles them.
 */
export function LegalPage({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[800px] px-4 pt-14 pb-24 sm:px-6 md:pt-20">
      <h1 className="text-[34px] leading-[40px] font-semibold tracking-[-0.03em] sm:text-[44px] sm:leading-[50px]">
        {title}
      </h1>
      <p className="mt-3 text-[15px] text-white/65">Last updated {site.updated}</p>
      <article className="mt-10 rounded-[16px] bg-white px-6 py-8 text-[15px] leading-7 text-[#262330] shadow-[0_30px_80px_-30px_rgb(10_4_30/0.7)] sm:px-10 sm:py-10 [&_a]:font-medium [&_a]:text-[#6941c6] [&_a]:underline [&_a]:underline-offset-2 [&_h2]:mt-9 [&_h2]:mb-2 [&_h2]:text-[19px] [&_h2]:leading-7 [&_h2]:font-semibold [&_h2]:tracking-[-0.015em] [&_h2]:text-[#14111f] [&_li]:mt-1.5 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
        <p className="!mt-0 text-[16px] text-[#3d3a46]">{intro}</p>
        {children}
      </article>
    </div>
  );
}
