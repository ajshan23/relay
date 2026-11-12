/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { ActionButton, FallbackLink, Heading, Layout, Paragraph, Small } from "./layout";

export type TeamInvitationProps = {
  inviterName: string;
  inviterEmail: string;
  organizationName: string;
  /** In plain words, for example "an admin" or "a team member". */
  roleLabel: string;
  url: string;
  expiresInDays: number;
};

/** An invitation to join a business on Relay. */
export default function TeamInvitation(props: TeamInvitationProps) {
  const { inviterName, inviterEmail, organizationName, roleLabel, url, expiresInDays } = props;
  return (
    <Layout preview={`${inviterName} invited you to ${organizationName} on Relay`}>
      <Heading>Join {organizationName} on Relay</Heading>
      <Paragraph>
        {inviterName} ({inviterEmail}) invited you to join {organizationName} as {roleLabel}. Relay is where
        the team answers customers on WhatsApp, Instagram and website chat.
      </Paragraph>
      <ActionButton href={url}>Accept invitation</ActionButton>
      <Small>
        The invitation works for {expiresInDays} days. Sign in or create an account with this email address to
        join.
      </Small>
      <FallbackLink href={url} />
    </Layout>
  );
}

TeamInvitation.PreviewProps = {
  inviterName: "Sara Malik",
  inviterEmail: "sara@harbour.test",
  organizationName: "Harbour Dental",
  roleLabel: "a team member",
  url: "http://localhost:3200/accept-invitation/inv_sample",
  expiresInDays: 2,
} satisfies TeamInvitationProps;
