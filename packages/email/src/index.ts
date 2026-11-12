/*
 * @relay/email: every email Relay sends goes through here.
 *
 *   API and other producers:  createEmailOutbox({ db, connection }).queueEmail(kind, to, data)
 *   Worker (emails queue):    createEmailSender({ db, provider: providerFromEnv() })
 *   Templates:                src/templates, listed in src/catalog.ts; preview with `pnpm --filter @relay/email preview`
 */
export { catalog, type EmailData, type EmailKind } from "./catalog";
export { createEmailOutbox, type EmailJob, type EmailOutbox, type QueueEmailOptions } from "./outbox";
export { type EmailProvider, logProvider, PermanentEmailError, resendProvider } from "./provider";
export { renderEmail } from "./render";
export { createEmailSender, providerFromEnv } from "./sender";
