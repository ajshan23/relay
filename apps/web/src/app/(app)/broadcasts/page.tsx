import { BroadcastsPage } from "@/components/broadcasts/list";

/** Driven by the URL (?view=) and live data: nothing to prerender. */
export const instant = false;

export default function Page() {
  return <BroadcastsPage />;
}
