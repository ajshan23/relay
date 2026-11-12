import { env } from "@relay/core";
import { eq, schema, sql } from "@relay/db";
import { type Job, UnrecoverableError } from "bullmq";
import { catalog } from "./catalog";
import type { Db, EmailJob } from "./outbox";
import { type EmailProvider, logProvider, PermanentEmailError, resendProvider } from "./provider";
import { renderEmail } from "./render";

/** Resend when a key is set; otherwise emails are printed to the log, so local development needs no setup. */
export function providerFromEnv(): EmailProvider {
  const config = env();
  return config.RESEND_API_KEY ? resendProvider(config.RESEND_API_KEY) : logProvider();
}

/**
 * Sends one queued email: render it, hand it to the provider, and record the outcome in email_log.
 * Used by the worker for the emails queue. Throwing makes the queue retry; permanent failures
 * (bad address, unverified sending domain) stop at once.
 */
export function createEmailSender({ db, provider }: { db: Db; provider: EmailProvider }) {
  const config = env();

  return async function sendQueuedEmail(job: Job<EmailJob>) {
    const { logId, kind, to, data } = job.data;
    const attempt = job.attemptsMade + 1;
    const lastAttempt = attempt >= (job.opts.attempts ?? 1);

    try {
      const email = await renderEmail(kind, data as never);
      const { id } = await provider.send({
        from: config.EMAIL_FROM,
        to,
        replyTo: config.EMAIL_REPLY_TO || undefined,
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: [
          { name: "kind", value: kind },
          { name: "category", value: catalog[kind].category },
        ],
        idempotencyKey: logId,
      });
      await db
        .update(schema.emailLog)
        .set({
          status: "sent",
          provider: provider.name,
          providerMessageId: id,
          attempts: attempt,
          error: null,
          sentAt: new Date(),
        })
        .where(eq(schema.emailLog.id, logId));
    } catch (err) {
      const permanent = err instanceof PermanentEmailError;
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.emailLog)
        .set({
          status: permanent || lastAttempt ? "failed" : "queued",
          provider: provider.name,
          attempts: sql`${schema.emailLog.attempts} + 1`,
          error: message,
        })
        .where(eq(schema.emailLog.id, logId));
      console.error(
        `[email] ${kind} to ${to} failed (attempt ${attempt}${permanent ? ", permanent" : ""}): ${message}`,
      );
      if (permanent) throw new UnrecoverableError(message);
      throw err;
    }
  };
}
