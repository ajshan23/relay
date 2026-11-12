/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Section, Text } from "@react-email/components";
import { brand, Heading, Layout, Paragraph, Small } from "./layout";

export type VerifyCodeProps = {
  code: string;
  /** Why the code was sent: confirming a new account, or signing in to an unconfirmed one. */
  purpose: "sign-up" | "sign-in";
  expiresInMinutes: number;
};

/** The 6-digit code that confirms an email address. */
export default function VerifyCode({ code, purpose, expiresInMinutes }: VerifyCodeProps) {
  return (
    <Layout preview={`${code} is your Relay code`}>
      <Heading>{purpose === "sign-up" ? "Confirm your email" : "Your sign-in code"}</Heading>
      <Paragraph>
        {purpose === "sign-up"
          ? "Enter this code in Relay to finish creating your account."
          : "Enter this code in Relay to confirm your email and sign in."}
      </Paragraph>
      <Section
        style={{
          backgroundColor: brand.lilac,
          borderRadius: 10,
          padding: "18px 0",
          textAlign: "center",
          margin: "4px 0 0",
        }}
      >
        <Text
          style={{
            fontSize: 32,
            lineHeight: "36px",
            fontWeight: 700,
            letterSpacing: "8px",
            color: brand.ink,
            margin: 0,
            fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
          }}
        >
          {code}
        </Text>
      </Section>
      <Small>
        The code works for {expiresInMinutes} minutes. Never share it: Relay will never ask you for it.
      </Small>
    </Layout>
  );
}

VerifyCode.PreviewProps = {
  code: "482193",
  purpose: "sign-up",
  expiresInMinutes: 10,
} satisfies VerifyCodeProps;
