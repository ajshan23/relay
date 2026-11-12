/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { ActionButton, FallbackLink, Heading, Layout, Paragraph, Small } from "./layout";

export type ResetPasswordProps = { url: string; expiresInMinutes: number };

/** The link to choose a new password. */
export default function ResetPassword({ url, expiresInMinutes }: ResetPasswordProps) {
  return (
    <Layout preview="Choose a new password for Relay">
      <Heading>Reset your password</Heading>
      <Paragraph>
        Someone asked to reset the password for your Relay account. If it was you, choose a new one:
      </Paragraph>
      <ActionButton href={url}>Choose a new password</ActionButton>
      <Small>
        The link works once, for {expiresInMinutes} minutes. If you didn't ask for this, ignore this email;
        your password stays the same.
      </Small>
      <FallbackLink href={url} />
    </Layout>
  );
}

ResetPassword.PreviewProps = {
  url: "http://localhost:3200/api/auth/reset-password/sample-token?callbackURL=http%3A%2F%2Flocalhost%3A3200%2Freset-password",
  expiresInMinutes: 60,
} satisfies ResetPasswordProps;
