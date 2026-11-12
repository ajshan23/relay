import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of Service · Relay" };

/** Placeholder until the real text is written; it must be replaced before launch. */
export default function Page() {
  return (
    <>
      <h1 className="text-[28px] leading-[34px] font-semibold tracking-[-0.02em]">Terms of Service</h1>
      <p className="text-muted-foreground">
        This page is a placeholder. The final Terms of Service will be published here before Relay opens to
        customers.
      </p>
    </>
  );
}
