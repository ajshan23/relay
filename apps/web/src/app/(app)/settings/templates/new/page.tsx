import { Suspense } from "react";
import { NewTemplate } from "@/components/templates/pages";

/** Driven by the URL (?from= or the template id) and live data: nothing to prerender. */
export const instant = false;

/** A new template, blank or from a ready-made one (?from=<library key>). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <NewTemplate />
    </Suspense>
  );
}
