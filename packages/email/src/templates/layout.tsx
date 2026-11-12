/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Body, Container, Head, Hr, Html, Link, Preview, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";

/*
 * The frame every Relay email shares: the mark, one white card and a short footer.
 * Email clients are old and strict, so this uses tables (via React Email), inline styles
 * and no SVG or web fonts.
 */

export const brand = {
  violet: "#6941C6",
  ink: "#100F0F",
  muted: "#656565",
  line: "#E8E8E8",
  page: "#F5F4F8",
  lilac: "#F0EBFA",
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

export function Layout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: brand.page, fontFamily: brand.font, margin: 0, padding: "32px 12px" }}>
        <Container style={{ maxWidth: 480, margin: "0 auto" }}>
          <Section style={{ paddingBottom: 20 }}>
            <table role="presentation" cellPadding={0} cellSpacing={0}>
              <tbody>
                <tr>
                  <td
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      backgroundColor: brand.violet,
                      color: "#FFFFFF",
                      fontSize: 15,
                      fontWeight: 700,
                      textAlign: "center",
                      lineHeight: "28px",
                    }}
                  >
                    R
                  </td>
                  <td style={{ paddingLeft: 10, fontSize: 16, fontWeight: 600, color: brand.ink }}>Relay</td>
                </tr>
              </tbody>
            </table>
          </Section>
          <Section
            style={{
              backgroundColor: "#FFFFFF",
              border: `1px solid ${brand.line}`,
              borderRadius: 12,
              padding: "32px 32px 28px",
            }}
          >
            {children}
          </Section>
          <Text style={{ fontSize: 12, lineHeight: "18px", color: brand.muted, margin: "20px 4px 0" }}>
            Sent by Relay. If you didn't expect this email, you can ignore it.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontSize: 22, lineHeight: "28px", fontWeight: 600, color: brand.ink, margin: "0 0 12px" }}>
      {children}
    </Text>
  );
}

export function Paragraph({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontSize: 15, lineHeight: "24px", color: brand.ink, margin: "0 0 16px" }}>{children}</Text>
  );
}

export function Small({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontSize: 13, lineHeight: "20px", color: brand.muted, margin: "16px 0 0" }}>
      {children}
    </Text>
  );
}

/** The main action. A real link styled as a button, so it works in every client. */
export function ActionButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "8px 0 4px" }}>
      <Link
        href={href}
        style={{
          display: "inline-block",
          backgroundColor: brand.violet,
          color: "#FFFFFF",
          fontSize: 15,
          fontWeight: 600,
          textDecoration: "none",
          padding: "12px 22px",
          borderRadius: 8,
        }}
      >
        {children}
      </Link>
    </Section>
  );
}

/** The plain link under a button, for clients that block buttons. */
export function FallbackLink({ href }: { href: string }) {
  return (
    <>
      <Hr style={{ borderColor: brand.line, margin: "24px 0 12px" }} />
      <Text style={{ fontSize: 12, lineHeight: "18px", color: brand.muted, margin: 0 }}>
        If the button doesn't work, copy this link into your browser:
        <br />
        <Link href={href} style={{ color: brand.violet, wordBreak: "break-all" }}>
          {href}
        </Link>
      </Text>
    </>
  );
}
