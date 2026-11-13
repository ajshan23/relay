import { Suspense } from "react";
import { ContactsPage } from "@/components/contacts/contacts-page";

/* Contacts are driven by the URL (?view=) and live data, so nothing is prerendered. */
export const instant = false;

export default function Page() {
  return (
    <Suspense fallback={<div className="h-full bg-background" />}>
      <ContactsPage />
    </Suspense>
  );
}
