import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/legal-page";
import { site } from "@/components/site/site";

export const metadata: Metadata = { title: "Terms of Service · Relay" };

export default function Page() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={`These terms are an agreement between your business and ${site.operator} for the use of ${site.name}. By creating an account you accept them on behalf of your business.`}
    >
      <h2>The service</h2>
      <p>
        {site.name} lets your business connect messaging channels such as WhatsApp, answer customers with your
        team and an AI agent, and send campaigns. Features may change as we improve the product; we will tell
        you before removing anything you rely on.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must give accurate information and keep your sign-in details safe.</li>
        <li>You are responsible for what your team members do in your account.</li>
        <li>You must be authorised to act for the business that owns the connected phone numbers.</li>
      </ul>

      <h2>WhatsApp and Meta's rules</h2>
      <p>
        Messages are sent through Meta's WhatsApp Business Platform. You agree to follow the WhatsApp Business
        Terms of Service, the WhatsApp Business Messaging Policy and the WhatsApp Commerce Policy. In
        particular:
      </p>
      <ul>
        <li>Only message people who have agreed to hear from your business, and honour opt-out requests.</li>
        <li>Do not send spam, illegal content, or content Meta does not allow.</li>
        <li>
          Meta may limit or block numbers that break its rules; we may pause sending to protect your number.
        </li>
        <li>Meta charges for some messages; those charges are yours, at Meta's published rates.</li>
      </ul>

      <h2>The AI agent</h2>
      <p>
        When you turn on the AI agent, it replies to customers using the information you provide. You decide
        what it may do and you can take over any conversation. AI replies can be wrong; you are responsible
        for the information you give it and for checking its work where it matters.
      </p>

      <h2>Your data</h2>
      <p>
        Your business owns its data, including conversations and contacts. We process it only to provide the
        service, as described in our <Link href="/privacy">Privacy Policy</Link>. You can export or delete it
        at any time.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use {site.name} to break the law, harass people, send unsolicited bulk messages, or try to
        access other customers' data or disrupt the service.
      </p>

      <h2>Fees</h2>
      <p>
        {site.name} is free during early access. Before paid plans start, we will tell you the prices and you
        can choose whether to continue.
      </p>

      <h2>Suspension and closing your account</h2>
      <p>
        You can close your account at any time. We may suspend an account that breaks these terms or puts
        other customers or the platform at risk, and will tell you why unless the law prevents it.
      </p>

      <h2>Liability</h2>
      <p>
        The service is provided as is. To the extent the law allows, we are not liable for indirect or
        consequential losses, and our total liability is limited to the amount you paid us in the 12 months
        before the claim.
      </p>

      <h2>Changes and law</h2>
      <p>
        We may update these terms and will tell account owners by email before important changes take effect.
        These terms are governed by the laws of {site.country}.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${site.email}`}>{site.email}</a>
      </p>
    </LegalPage>
  );
}
