# @relay/email

Every email Relay sends goes through this package. Nothing else talks to Resend.

## How an email travels

1. **Queue it** from anywhere (API, worker, later flows and campaigns):

   ```ts
   const outbox = createEmailOutbox({ db, connection: redis });
   await outbox.queueEmail("team-invitation", "rana@example.com", { ...data }, { organizationId });
   ```

   This writes a row to `email_log` (status `queued`) and adds a job to the `emails` queue. It returns at once.
2. **The worker sends it** (`apps/worker`): renders the template, sends through the provider with the
   `email_log` id as the idempotency key (a retry can never send twice), and marks the row `sent` or `failed`.
3. **Retries** depend on the email's category: account emails (codes, resets) 4 tries within seconds;
   team and product emails up to 6 tries over minutes. Permanent errors (bad address, unverified domain) stop at once.

`email_log` keeps kind, recipient, subject, status, provider message id, attempts and the last error.
The template data (codes, reset links) is never stored there: it lives only in the queue job, which is
deleted when sent and after 24 hours if it failed.

## Adding an email

1. Write a template in `src/templates/<name>.tsx` with a default export and `PreviewProps`, using `Layout`.
2. Add its data type to `EmailData` and an entry to `catalog` in `src/catalog.ts` (subject and category).
3. Queue it with `outbox.queueEmail("<name>", to, data)`. TypeScript checks the data matches.

Preview every template in the browser: `pnpm --filter @relay/email preview` (http://localhost:3203).

## Provider

- `RESEND_API_KEY` set: emails go out through Resend from `EMAIL_FROM` (replies to `EMAIL_REPLY_TO` if set).
- No key: emails are printed to the worker log instead, so local development needs no setup.
- `EMAIL_FROM` must use a domain verified in Resend. `onboarding@resend.dev` works for testing but only
  delivers to the email address of the Resend account.

## Current emails

| Kind               | When                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `verify-code`      | Sign-up, and signing in to an account whose email is not confirmed yet |
| `reset-password`   | Forgot password                                                        |
| `team-invitation`  | An owner or admin invites someone to the business                      |
| `existing-account` | Someone signs up with an email that already has an account             |

## Not done yet

- Resend webhooks (delivered, bounced, complained) to update `email_log` and stop sending to bad addresses.
- Unsubscribe links and preferences for product emails (account emails cannot be unsubscribed from).
