import { Resend } from "resend";

export type OutgoingEmail = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  tags: { name: string; value: string }[];
  /** Same key, same email: the provider sends it at most once, so retries are safe. */
  idempotencyKey: string;
};

/** Where emails go. Resend in real use; the log provider prints them for local development. */
export type EmailProvider = {
  name: string;
  send(email: OutgoingEmail): Promise<{ id: string }>;
};

/** A send that should not be retried (bad address, unverified domain, blocked by the provider). */
export class PermanentEmailError extends Error {}

export function resendProvider(apiKey: string): EmailProvider {
  const resend = new Resend(apiKey);
  return {
    name: "resend",
    async send({ idempotencyKey, ...email }) {
      const { data, error } = await resend.emails.send(email, { idempotencyKey });
      if (error) {
        // 4xx answers (validation, unverified domain, restricted test sender) will not fix themselves.
        const status = error.statusCode ?? 0;
        const message = `${error.name}: ${error.message}`;
        if (status >= 400 && status < 500 && status !== 429) throw new PermanentEmailError(message);
        throw new Error(message);
      }
      if (!data) throw new Error("Resend returned no message id");
      return { id: data.id };
    },
  };
}

export function logProvider(): EmailProvider {
  return {
    name: "log",
    async send(email) {
      console.log(
        `\n[email] (not sent: no RESEND_API_KEY) to ${email.to}\n  ${email.subject}\n\n${email.text}\n`,
      );
      return { id: `log_${email.idempotencyKey}` };
    },
  };
}
