# Setting up Google Calendar for bookings

Relay connects each branch's Google Calendar through the same Google Cloud project as "Sign in with Google". These steps are done once, in the Google Cloud Console, by whoever owns that project.

## 1. Turn on the Calendar API
APIs & Services → Library → **Google Calendar API** → Enable.

## 2. Add the scopes to the consent screen
Google Auth Platform (OAuth consent screen) → Data access → Add or remove scopes. Add these three. Each is the narrowest one that does the job:

| Scope | Why Relay needs it |
|---|---|
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | Show the business which of its calendars it can choose for bookings. |
| `https://www.googleapis.com/auth/calendar.freebusy` | Read when the business is busy, so customers aren't offered those times. Only busy or free, never event details. |
| `https://www.googleapis.com/auth/calendar.events.owned` | Add, move and remove the events for bookings made in Relay, only on calendars the business owns. |

`openid` and `email` (already used for sign-in) show which Google account is connected.

## 3. Add the redirect addresses
Clients → the web client used for sign-in → Authorized redirect URIs. Add:

- `https://app.relay.operium.pro/api/bookings/google/callback`
- `http://localhost:3200/api/bookings/google/callback` (local development)

The server also needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CHANNEL_SECRET_KEY` and `WEB_URL` in `.env`. These already exist for sign-in and channels.

## 4. While it's in "Testing"
- Only accounts listed under **Audience → Test users** can connect. Add yours.
- Google ends a test connection after **7 days**. The branch then shows "Needs connecting again", and bookings keep working in Relay. This stops once the app is verified.

## 5. Get the app verified (for every business to use it)
Audience → Publish app, then submit for verification. Calendar scopes are *sensitive*, not restricted: Google checks the app, but there's no paid security assessment. Google says it takes up to about 10 days.

You'll need:
- **Privacy policy:** https://relay.operium.pro/privacy (already live). It must say Relay uses Google Calendar data only to show free times and keep bookings in the business's calendar, and never shares or sells it.
- **Home page:** https://relay.operium.pro
- **Why each scope:** the table above.
- **A demo video** (unlisted YouTube link), about 2–3 minutes, showing the consent screen with the app name and scopes:
  1. Relay → AI agent → Booking settings → **Connect Google Calendar**. Show Google's consent screen with the three permissions, then allow.
  2. Back in Relay: the connected account and **Calendar for bookings** (the picker shows owned calendars).
  3. Make a service **Online (Google Meet link)** in the catalogue.
  4. In Google Calendar, add a busy event tomorrow at 10:00. In Relay's Try, ask to book that service tomorrow: 10:00 isn't offered.
  5. Book another time and tap Yes. The event appears in Google Calendar, marked free, with a Meet link, and the Meet link is in the reply.
  6. Move and cancel the booking in Bookings, and show the event moving and disappearing in Google.
  7. **Disconnect** in Booking settings.

## What Relay stores
- The refresh and access tokens, encrypted with `CHANNEL_SECRET_KEY`.
- The chosen calendar and the list of owned calendars.
- For each booking, its Google event id and Meet link.

Disconnecting revokes the token and deletes these. Events already added stay in the calendar.

## Google Tasks (follow-ups from the AI agent)
The AI agent can add follow-ups for the team (call backs, questions to check, quotes) to a branch's Google Tasks. It uses the same Google project, client and redirect address as the calendar, so no new redirect URI is needed.

1. APIs & Services → Library → **Google Tasks API** → Enable.
2. Google Auth Platform → Data access → add the scope `https://www.googleapis.com/auth/tasks` ("See, edit, create and delete all your tasks"). It's *sensitive*, like the calendar scopes, so it goes in the same verification. Why Relay needs it: add the AI agent's follow-up tasks to the list the business picks, make a "WhatsApp follow-ups" list, and see whether a task was ticked off so the agent doesn't add it again.
3. For the verification video, also show: AI agent → Tools → **Connect Google Tasks** → Google's consent screen → back in Relay, the chosen list → in a chat, the agent adds a follow-up and it appears in Google Tasks.

While the app is in "Testing", the same 7-day limit applies: the card then shows "Needs connecting again", and the agent only notes follow-ups in the chat until it's reconnected.

Disconnecting Google Tasks (or the calendar) doesn't revoke Relay's Google access while another branch's calendar or tasks still uses the same Google account, because revoking ends all of it at once.
