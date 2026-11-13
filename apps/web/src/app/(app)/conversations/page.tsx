import { Suspense } from "react";
import { Inbox } from "@/components/inbox/inbox";

/*
 * The inbox is driven by the URL (?view=&channel=&c=) and live data, so there is nothing to prerender:
 * it renders inside its own Suspense boundary and is opted out of instant-navigation validation.
 */
export const instant = false;

export default function Page() {
  return (
    <Suspense fallback={<div className="h-full bg-background" />}>
      <Inbox />
    </Suspense>
  );
}
