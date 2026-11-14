import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/legal-page";
import { site } from "@/components/site/site";

export const metadata: Metadata = { title: "Privacy Policy · Relay" };

export default function Page() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={`This policy explains what information ${site.name} collects, why, who it is shared with, and the choices you have. ${site.name} is operated by ${site.operator}, ${site.country}.`}
    >
      <h2>Who this covers</h2>
      <p>
        {site.name} is software that businesses use to talk to their customers on WhatsApp and other messaging
        channels. There are two groups of people whose information we handle:
      </p>
      <ul>
        <li>
          <strong>Our customers and their team members</strong>: the businesses that sign up and the people
          they invite. For their account information, we decide how it is used.
        </li>
        <li>
          <strong>The people those businesses talk to</strong>: their customers who send or receive messages.
          For this information, the business decides how it is used, and we process it on the business's
          behalf and on its instructions.
        </li>
      </ul>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account information</strong>: name, email address, password (stored only as a secure hash),
          the business's name, branches and settings.
        </li>
        <li>
          <strong>Connected channel information</strong>: when a business connects WhatsApp, we receive from
          Meta the IDs of its WhatsApp Business Account and phone numbers, and an access token that lets us
          send and receive messages for it.
        </li>
        <li>
          <strong>Conversation data</strong>: messages, photos, files, voice notes and message status (sent,
          delivered, read), the contact's name and phone number as provided by WhatsApp, and any notes, tags
          or details the business adds.
        </li>
        <li>
          <strong>Usage and technical data</strong>: log entries such as IP address, browser type and the time
          of requests, used to keep the service secure and working.
        </li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>
          To provide the service: show conversations, send the messages a business or its AI agent writes, and
          run its campaigns.
        </li>
        <li>
          To run the AI agent (Mira) when the business turns it on: messages and the business's own
          information are sent to an AI model provider to draft replies. They are not used to train public
          models.
        </li>
        <li>To keep accounts secure, prevent abuse and fix problems.</li>
        <li>To send account emails such as sign-in codes, invitations and important service notices.</li>
      </ul>
      <p>We do not sell personal information, and we do not use conversation data for advertising.</p>

      <h2>Who we share it with</h2>
      <ul>
        <li>
          <strong>Meta Platforms</strong>, to send and receive WhatsApp messages through the WhatsApp Business
          Platform.
        </li>
        <li>
          <strong>Amazon Web Services</strong>, where files such as photos and documents are stored.
        </li>
        <li>
          <strong>Our hosting, email and AI model providers</strong>, only as needed to run the service, under
          contracts that protect the data.
        </li>
        <li>Authorities, when the law requires it.</li>
      </ul>

      <h2>How long we keep it</h2>
      <p>
        We keep a business's data for as long as its account is open. When a business deletes a conversation,
        contact or file, or closes its account, we delete the related data within 30 days, except where we
        must keep records by law. Backups are overwritten within a further 30 days.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        You can ask to see, correct, export or delete your information. If you are a customer of a business
        that uses {site.name}, please contact that business first, since it controls your conversation data;
        we will help it respond. See <Link href="/data-deletion">how to request data deletion</Link>.
      </p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit. Channel access tokens are encrypted in our database, passwords are
        stored only as secure hashes, and team access is limited by role.
      </p>

      <h2>Changes</h2>
      <p>
        If we change this policy in a way that matters, we will tell account owners by email before it takes
        effect.
      </p>

      <h2>Contact</h2>
      <p>
        Questions or requests: <a href={`mailto:${site.email}`}>{site.email}</a>.
      </p>
    </LegalPage>
  );
}
