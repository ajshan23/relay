# Foundation plan: channels, data model, build order

Drafted 2026-11-12. Product name is undecided; `relay` is the working folder name.
Based on private platform research kept outside the repo.

## 1. Do all Meta channels send the same webhooks?

Partly. They share the outer envelope and the security, not the message format.

| | WhatsApp | Messenger | Instagram |
|---|---|---|---|
| Setup handshake (GET with verify token) | same | same | same |
| Signature (`X-Hub-Signature-256`, app secret) | same | same | same |
| Outer shape | `object` + `entry[]` | `object` + `entry[]` | `object` + `entry[]` |
| `object` value | `whatsapp_business_account` | `page` | `instagram` |
| Messages live in | `entry[].changes[].value.messages[]` | `entry[].messaging[]` | `entry[].messaging[]` |
| Delivery/read status | `value.statuses[]` | separate `messaging` events | `messaging_seen` events |
| Customer ID | phone and/or business-scoped user ID | PSID (per Page) | IGSID (per IG account) |
| Our own sends echoed back | no | yes (`is_echo`) | yes (`is_echo`) |
| Send endpoint | `/{phone-number-id}/messages` | `/{page-id}/messages` | `/{ig-account-id}/messages` |

So: **one webhook receiver for all of Meta, two parsers** (WhatsApp, and a shared one for Messenger + Instagram). SMS, email and web chat each bring their own parser. Everything after the parser is channel-agnostic.

## 2. Channel adapter

Every channel is a small adapter with the same five jobs. The rest of the product never sees a provider payload.

```ts
interface ChannelAdapter {
  verifyWebhook(req): boolean                    // signature / handshake
  parseWebhook(payload): NormalizedEvent[]       // provider shape -> our shape
  send(account, msg: OutboundMessage): Promise<{ externalId: string }>
  fetchMedia(account, ref): Promise<Stream>      // copy to our storage
  capabilities: ChannelCapabilities
}
```

`NormalizedEvent` is one of: `message.received`, `message.status` (sent, delivered, read, failed), `message.echo`, `reaction`, `button.click`, `thread.ownership` (someone else holds the conversation), `account.update`, `template.status`.

`ChannelCapabilities` is how the UI and the flow engine learn channel rules without `if (whatsapp)` scattered around:

| Capability | WhatsApp | Instagram | Messenger | Web chat | SMS |
|---|---|---|---|---|---|
| Reply window | 24h | 24h (7d human) | 24h (7d human) | none | none |
| Templates needed outside window | yes | no such thing | utility templates | no | no |
| Buttons / quick replies | 3 buttons, lists | 13 quick replies | yes | ours to define | no |
| Media | yes | image, video, audio, PDF | yes | yes | MMS only |
| Read receipts | yes | yes | yes | yes | no |
| Typing indicator | yes | yes | yes | yes | no |

Adding SMS later means writing one adapter (for example Twilio or MSG91) and one capabilities row. No schema change.

## 3. Data model (Postgres)

Every business table carries `org_id` and `branch_id`. Isolation is enforced once, with Postgres row-level security, not in each query.

**Tenancy**
- `organizations`
- `branches` (belongs to an organization)
- `users`
- `org_members` (user, organization, org role)
- `branch_members` (user, branch, branch role) — a user can sit in several branches with different roles
- `roles`, `role_permissions` — permission keys like `inbox.reply`, `channels.manage`

**Channels**
- `channel_accounts`
  - `channel_type`: whatsapp, instagram, messenger, webchat, sms, email
  - `provider`: meta, twilio, own
  - `external_id`: phone number ID, Page ID, IG account ID, widget ID
  - `credentials` (encrypted), `status`, `display_name`
  - `provider_meta` (JSON): Messaging account ID, business ID, and a reserved slot for the WhatsApp account ID that replaces phone-number IDs in 2028

**People**
- `contacts` — our own record of a person; no channel ID on it
- `contact_identities` — one row per way to reach them
  - `channel_type`, `external_id` (business-scoped user ID, PSID, IGSID, visitor ID), `phone` (nullable), `channel_account_id` where the ID is scoped to one account
  - merging two contacts is moving identity rows; nothing else changes

**Conversations**
- `conversations` — one per contact per channel account
  - `status`, `assignee_id`, `window_expires_at`, `thread_owner` (us, or external), `last_message_at`
- `messages`
  - `direction`, `sender_type` (contact, user, bot, ai_agent, system)
  - `type` and `content` (JSON) in our normalized shape
  - `external_id`, unique per channel account — this is the idempotency key for duplicate webhooks
  - `status`, `error`, `reply_to_id`
- `attachments` — files copied into our storage on arrival

**Plumbing**
- `webhook_events` — every raw payload as received, with a dedupe key and `processed_at`; lets us replay after a bug
- `outbox` — one row per outgoing message with attempts and next retry time, since Meta offers no idempotency key and no ordering guarantee

## 4. Architecture

Three running pieces and shared packages, in one repository.

```
apps/web       Next.js + shadcn/ui     the product UI
apps/api       TypeScript HTTP API     auth, REST, webhook receiver, realtime
apps/worker    BullMQ workers          webhook processing, outbox sender, later flows and campaigns
packages/db        schema + migrations
packages/channels  the adapters
packages/core      domain logic shared by api and worker
```

- **Webhook path:** receive, verify signature, store raw, enqueue, return 200. The worker parses and writes. Meta never waits on our processing.
- **Realtime inbox:** the worker publishes to Redis; the API pushes to browsers over a WebSocket.
- **Auth:** Better Auth in our own Postgres (decided earlier: no Clerk). Branches and permissions are our tables.
- **Billing:** Stripe directly, later.
- **Flows:** Postgres state machine plus delayed jobs. Decided when we design the engine.

Defaults I have picked, easy to change before scaffolding: pnpm workspaces with Turborepo, Fastify for the API, Drizzle for the schema.

## 5. Build order

Each step ends in something you can click.

1. **Scaffold.** Repository, local Postgres and Redis in Docker, CI-free for now.
2. **Accounts.** Sign up, sign in, create organization, create branches, invite users, roles. App shell with branch switcher.
3. **Channel layer + WhatsApp.** Adapter interface, webhook receiver, raw event store. Connect our own test number by pasting its IDs and token into a dev-only screen.
4. **Inbox.** Conversation list, thread view, send text and media, delivery and read ticks, live updates, assign to a teammate, reply-window indicator.
5. **Customer onboarding.** Embedded Signup v5, then App Review submission.

After that, in an order we choose later: web chat widget, Instagram and Messenger adapters, flow builder, AI agents, campaigns, analytics, billing.

## 6. Changes after the open-source study

The study of 108 reference repos (`../opensource/notes/00-common-patterns.md`) changes these points. Where this section and the ones above differ, this section wins.

- **Tenant isolation:** a scoped data-access layer where every query requires organization and branch, plus a guard against unfiltered updates and deletes. No row-level security in v1.
- **Reply window:** tracked per contact identity and channel account, not per conversation.
- **Templates:** their own table, synced from Meta.
- **Conversation controller:** exactly one of flow, AI agent, human or external at a time.
- **Auth split:** Better Auth owns organization, member and invitation. We own `branches` and `branch_members` with the role, since Better Auth teams carry no role.
- **URLs:** `/[org]/[branch]/...`.
- **IDs:** prefixed and time-sortable.
- **Per-number throttle:** a Redis token bucket of our own.
- **Flow engine:** confirmed as Postgres run, step and wait rows with a sweeper.
- **API framework:** Hono, decided 2026-11-12. One API organised as modules (folders), no Moleculer or other microservice framework.
- **Scaffold:** done 2026-11-12. Web on 3200, API on 3201, Postgres on 5544, Redis on 6390.

## 7. Needed from you

- A Meta Business app under the verified portfolio with the WhatsApp use case added (needed at step 3).
- Later, a second business portfolio to test Embedded Signup (needed at step 5).

## 8. Design direction (decided 2026-11-12)

Chosen in the design lab (`apps/lab`, http://localhost:3210/?structure=assistant&theme=flowflex).

- **Structure:** "Board". A Linear-style sidebar that folds to icons, a home board sorted by who has each chat (Waiting for you, the AI agent is handling, Handled today), an assistant bar at the bottom, and a working panel on the right.
- **Colours:** FlowFlex light and FlowFlex dark. Values are in `apps/lab/src/lib/themes.ts`.
- **Type and shape:** Inter, 4px corners.
- **Rule:** no shadcn component is used in its default style. Components are restyled through these tokens first.

## 9. Step 2 done: accounts (2026-11-12)

Sign up, sign in, sign out, create a business, first branch, more branches, invite people, per-branch roles.
The API contract is `02-accounts-api.md`. Test accounts are in `.env` (`DEV_TEST_*`).

Decisions made while building:
- URLs stay flat (`/today`, `/settings/branches`) for now; the active organization is on the session and the branch choice is in the browser. `/[org]/[branch]/...` is deferred until there is a reason for shareable branch links.
- Invitations can be accepted without a verified email (`requireEmailVerificationOnInvitation: false`) because no email is sent yet. Turn it back on with email delivery.
- Query helpers (`eq`, `and`, ...) are imported from `@relay/db`, never from `drizzle-orm`, because two copies of drizzle-orm are installed.

Open:
- The account is loaded in the browser (`apps/web/src/lib/me.tsx`), so signed-in pages flash blank first and Next's dev console logs an "instant navigation" warning. Fix by reading the session on the server (Next guide `authentication-with-cache-components`).
- No email delivery: password reset and invitation links are only printed in the API log.
- Timezone picker is a 400-item select; the design system needs a searchable combobox, link tabs and a row-action menu.

### Auth screens rebuilt (2026-11-12, later)

Built on shadcn's login-02 / signup-02 blocks and the shadcn `Field`, `InputGroup`, `InputOTP` and `Spinner` primitives (copied into `packages/ui/src/ui`, restyled to our tokens).

- Sign-up asks for a 6-digit email code before the account can sign in (Better Auth `emailOTP`, `requireEmailVerification`). A correct code signs the person in.
- Password field: show/hide, Caps Lock warning, strength meter (advice only; the server enforces 10+ characters).
- Google sign-in appears only when `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are set; the redirect URI is `${WEB_URL}/api/auth/callback/google`.
- Rate limits: 5 per minute on sign-in, sign-up, email codes and reset requests.
- `/terms` and `/privacy` are placeholders that must be replaced before launch.

Before launch:
- Email delivery (codes, reset links and invitations are only printed to the API log).
- The proxy in front of the web app must set `x-forwarded-for` to the real client IP; today every request shares one rate-limit bucket.
- Move rate-limit storage from memory to Redis before running more than one API process.
- Real Terms and Privacy text.

## 10. Channels: many of each type (decided 2026-11-13)

A business can connect **any number of channels of each type**: several WhatsApp numbers, several
Instagram accounts, several Facebook Pages, several website widgets, later several SMS numbers.

- Nothing may assume "the WhatsApp channel" of an organization or branch. Every conversation, message,
  template, campaign, contact identity and reply window points at a specific `channel_account`.
- A channel account belongs to an organization and is assigned to one or more branches.
- Webhooks are routed to the right channel account by Meta's IDs (phone number ID, Page ID, IG account ID),
  never by channel type alone.
- The same customer can talk to two of our numbers; that is two conversations with one contact.
- Screens let people choose which channel to send from wherever more than one could apply
  (replies default to the channel the customer wrote on).

## 11. Step 4 done: inbox (2026-11-13)

Built against the fake Meta server; works unchanged with a real number once it is connected.

- **Layout:** the approved Board inbox, two panes (chat list + conversation), customer or group details in
  the side panel; phone width shows one pane at a time. URL state: `/conversations?view=&channel=&c=`.
- **Views:** Open, Assigned to me, Unassigned, Closed, with live counts in the sidebar; the sidebar's
  Channels group lists the business's connected channel accounts; the branch switcher filters the inbox.
- **Conversation:** shadcn Message/Bubble/MessageScroller; day separators; runs grouped by sender; group
  members' names and avatars; photos, video, voice notes, documents, locations; reactions on the bubble
  they react to; quoted replies; ticks (sending, sent, delivered, read; per-member counts in groups);
  failures in plain words with "Try again" (asks first when the message may already have gone out).
- **Composer:** Enter sends, files by button or drag and drop (checked against channel capabilities),
  reply-to, drafts kept per conversation, reply-window countdown; locked with the reason when the window
  closed, the group is gone, the channel is down or the person is a viewer.
- **Team:** assign (owners, admins, the branch's managers and agents), close/reopen, unread per person.
- **Live:** `/api/events` (SSE) fed by Redis pub/sub hints from the API and worker; the browser refetches.
  The stream must not be compressed by proxies (`Cache-Control: no-transform`).

Open: notes and mentions, snooze, canned replies, bulk actions, notifications and sounds, templates outside
the window, AI agent views, typing indicator, sending stickers, search inside a conversation.

## 12. Templates (2026-11-13)

Channel-agnostic message templates, WhatsApp first.

- **Model:** `@relay/core/templates` (purpose in plain words: updates, marketing, login; header, body with
  named details `{{customer_name}}`, footer, buttons; rules in plain words) and a 12-entry ready-made
  library (`@relay/core/template-library`). A template is written once and published to chosen channels;
  each `template_channel` copy has its own review state (draft, in review, ready, needs a change, paused,
  turned off). Accounts sharing templates (WhatsApp: one business account) share one copy id ("scope").
- **Channels:** `capabilities.templates` limits; optional adapter `templates` part (scope, submit, update,
  remove, list); reviews arrive as `template.status_changed`. WhatsApp maps to Meta components with named
  parameters; header examples go through Meta's resumable upload (needs `META_APP_ID`).
- **Screens:** Settings → Templates (empty state from the library, list with per-channel status, editor
  with live preview, review banner and toasts that update live). Inbox: the locked composer offers
  "Choose a template"; a template button sits in the toolbar; the picker pre-fills known details.
- **Fake review (local only):** the fake Graph approves 10 s after submission with a signed webhook
  (names containing "reject" are rejected); the UI still says review takes up to 2 hours.

Open: campaigns on top of templates, authentication-code buttons, carousels, translations of one template,
template analytics, SMS registration.

## 13. Catalogue and storage limit (2026-11-17)

One catalogue per branch for anything a business sells. Design and research: `research/08-mira-catalogue.md`.

- **Model.**
  - **Types:** business-wide, with typed fields; templates for Product, Service, Menu item, Property, Room, Course, Vehicle and Package.
  - **Items:** title, description, category and field values. Items carry no price.
  - **Variants:** price in minor units and currency, SKU, stock, and duration for services.
  - **Gallery:** an ordered list of photos, videos, audio and PDFs, one of them the primary.
- **Search.**
  - Exact filters run first: category with sub-categories, price on the sale price, stock, and choice, yes/no, number and date fields.
  - Then full-text and meaning ranking on the filtered rows. Embeddings are 512-dim halfvec from text-embedding-3-small.
  - There is deliberately no shared vector index: each query scans one branch's rows.
- **Media.**
  - The browser uploads straight to storage with a signed PUT.
  - The `catalog-media` queue prepares each file for WhatsApp: JPEG under 5 MB; H.264/AAC MP4 under 16 MB (ffmpeg); MP3; PDF.
  - Each business prepares one file at a time.
- **Mira.**
  - Tools: `search_catalog`, `get_item`, `show_items`, `show_item_media`.
  - A price guard stops a reply that quotes an amount not found in this turn's results or the chat.
  - **More details** taps are answered without a model call.
- **WhatsApp.**
  - One item goes as reply buttons with the item's photo on top. 2–10 items go as a carousel (signed links) or, if any lack a photo, as a list.
  - The team can send items from the inbox.
- **Import and copy.**
  - Excel and CSV import in the background, one import at a time per business. Rows with the same id become one item with options; importing again updates it.
  - **Copy to branch** shares files rather than duplicating them.
- **Storage.**
  - 500 MB per business for now (`storage_usage`, migration 0025). The business's own uploads are refused at the limit; files customers send are always kept.
  - The nightly file sweep recounts usage and keeps any file that knowledge, an agent or a gallery still uses.
- **Migrations.** 0025 (storage_usage) and 0026 (catalogue). They need ffmpeg/ffprobe on the server, plus a 1-day lifecycle rule on `uploads/`.

## 14. Voice notes for the AI agent (2026-11-18)

- Each agent has **Voice notes** on its Teach page: Off, Accurate (`gpt-4o-mini-transcribe`, 1 credit per started minute) or More accurate (`gpt-4o-transcribe`, 2 credits per started minute). New and existing agents default to Accurate (migration 0027).
- Before each answer, the agent's runtime hears the customer's voice notes from the last 30 minutes that have no text yet. This happens inside the per-turn `t<n>:live` step, so chats already running replay unchanged. Notes still downloading are waited for up to 20 s.
- The length comes from ffprobe. Notes over 3 minutes, failed downloads and failed calls are marked `transcriptSkipped` and never charged. The agent then asks the customer to type or send a shorter one.
- The text is saved on the message (`content.transcript`). The agent reads `[voice note] …`, and the inbox shows the text under the player.
- Usage rows have kind `transcribe`, are unique per message, and appear in `/api/agents/usage`. Models can be changed with `AI_TRANSCRIBE_MODEL` / `AI_TRANSCRIBE_MODEL_BEST`.
- **Cloudflare (2026-11-18):** when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN` are set, Accurate uses Cloudflare Workers AI `@cf/openai/whisper-large-v3-turbo`, sending the audio as base64 to `/accounts/{id}/ai/run/{model}`. That gives about 200 free minutes a day, then $0.0005 per minute. More accurate stays on OpenAI. Credits are unchanged (1 or 2 per minute).

## 15. Photos for the AI agent (2026-11-18)

- Each agent has **Photos** on its Teach page: Off, Accurate (1 credit per photo) or More accurate (2 credits per photo). The default is Accurate (migration 0028: `ai_agent.photos`, usage kind `vision`).
  - **Accurate** uses Cloudflare `@cf/meta/llama-4-scout-17b-16e-instruct` when the Cloudflare keys are set. Otherwise it uses OpenAI `gpt-5.4-mini` at low image detail.
  - **More accurate** uses `gpt-5.4-mini` at high detail.
- Before each answer, inside `t<n>:live` after voice notes, `apps/worker/src/agent/photos.ts` describes the customer's photos from the last 30 minutes that have no description yet:
  - at most 3 per turn; the older ones are marked `too_many`;
  - files over 10 MB are skipped;
  - each photo is shrunk to a 1024 px JPEG with sharp.
- The description is saved on the message as `content.description`. The agent reads `[photo you looked at] … Caption: "…"` and searches the catalogue with it. The inbox shows the description under the photo.
- The describing prompt names an exact model only when it's written in the photo, never identifies people, and treats text inside the photo as content, not instructions.
- **Cloudflare fallback, for voice notes and photos:** if a `@cf/` model fails for any reason (daily allowance used up, outage, bad token), the call is retried once on OpenAI. Usage records the model actually used.
- **Measured on real catalogue photos:** Cloudflare took about 7 s and cost about $0.0008 per photo after the free allowance; OpenAI at high detail took about 5 s and cost about $0.0016.

## 16. Voice replies (2026-11-18)

- Each agent has **Reply with voice** on its Teach page: Off (the default), To voice notes (when the customer's last message was a voice note), or Always. Migration 0029 adds `ai_agent.voice_replies` and the `speech` usage kind.
- Only plain replies are spoken. Cards, buttons, galleries and hand-overs are unchanged.
- **How a reply becomes a voice note:**
  1. The language comes from the reply's script (English, Arabic, Hindi or Malayalam; anything else stays as text).
  2. Formatting and emojis are removed.
  3. Cartesia (`CARTESIA_KEY`, `sonic-3`, voice `CARTESIA_VOICE_ID`, which defaults to the chosen voice) produces MP3.
  4. ffmpeg converts it to Ogg/Opus mono 48 kHz.
  5. It's stored and sent as `audio` with `voice: true`, so WhatsApp shows it as a voice note.
- What was said is saved as `content.transcript`, so the agent's history reads `[voice note you sent] …` and the inbox shows the text under the player.
- Replies containing links, emails or long numbers also go out as text.
- Replies over 600 characters, no credits left, an unsupported script or any Cartesia/ffmpeg failure fall back to plain text. Voice never blocks an answer.
- **Cost:** 1 extra credit per voice reply. On Cartesia, about $0.05 per 1,000 characters (about $0.0075 a reply).
- **Measured:** Cartesia about 1.8 s plus ffmpeg about 0.2 s for a 9.5-second reply.
