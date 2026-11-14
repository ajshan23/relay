import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/legal-page";
import { site } from "@/components/site/site";

export const metadata: Metadata = { title: "Data deletion · Relay" };

export default function Page() {
  return (
    <LegalPage
      title="Data deletion"
      intro={`How to have your information removed from ${site.name}, and what happens when you ask.`}
    >
      <h2>If you run a business on {site.name}</h2>
      <ul>
        <li>
          <strong>Delete a contact</strong>: owners and admins can open the contact in {site.name} and choose
          Delete. It is removed straight away, and from backups within 30 days.
        </li>
        <li>
          <strong>Disconnect WhatsApp</strong>: owners and admins can disconnect a number in Settings, which
          stops all sending and receiving. You can also remove {site.name}'s access in your Meta Business
          settings under Integrations. Conversations are kept until you delete them or your account.
        </li>
        <li>
          <strong>Delete your whole account</strong>: email us from the account owner's address at{" "}
          <a href={`mailto:${site.email}?subject=Delete%20my%20account`}>{site.email}</a>. We confirm, then
          delete the account, its conversations, contacts, files and settings within 30 days.
        </li>
      </ul>

      <h2>If you messaged a business that uses {site.name}</h2>
      <p>
        Your conversation belongs to that business, so please ask it first; it can delete your data in{" "}
        {site.name} directly. If you can't reach it, email <a href={`mailto:${site.email}`}>{site.email}</a>{" "}
        with your phone number and the business's name, and we will help.
      </p>

      <h2>What we keep</h2>
      <p>
        Backups are overwritten within a further 30 days. We keep only what the law requires, such as billing
        records, and nothing else.
      </p>

      <p>
        More detail is in our <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </LegalPage>
  );
}
