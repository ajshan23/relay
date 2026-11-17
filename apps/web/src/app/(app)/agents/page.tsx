import { AgentsPage } from "@/components/agents/agents-page";

/** Driven by the URL (?view=) and live data: nothing to prerender. */
export const instant = false;

export default function Page() {
  return <AgentsPage />;
}
