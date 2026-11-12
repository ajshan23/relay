/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Link } from "@react-email/components";
import { ActionButton, brand, Heading, Layout, Paragraph, Small } from "./layout";

export type ExistingAccountProps = { signInUrl: string; resetUrl: string };

/**
 * Sent when someone tries to sign up with an email that already has an account. The sign-up
 * screen looks the same either way (so nobody can learn who has an account); this email tells
 * the real owner what to do.
 */
export default function ExistingAccount({ signInUrl, resetUrl }: ExistingAccountProps) {
  return (
    <Layout preview="You already have a Relay account">
      <Heading>You already have an account</Heading>
      <Paragraph>
        Someone just tried to create a Relay account with this email address. You already have one, so no new
        account was made.
      </Paragraph>
      <ActionButton href={signInUrl}>Sign in</ActionButton>
      <Small>
        Forgot your password?{" "}
        <Link href={resetUrl} style={{ color: brand.violet }}>
          Reset it here
        </Link>
        . If this wasn't you, you can ignore this email.
      </Small>
    </Layout>
  );
}

ExistingAccount.PreviewProps = {
  signInUrl: "http://localhost:3200/sign-in",
  resetUrl: "http://localhost:3200/forgot-password",
} satisfies ExistingAccountProps;
