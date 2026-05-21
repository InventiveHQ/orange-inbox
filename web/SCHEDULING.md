# Meeting booking / scheduling

A Calendly-style booking layer on top of Orange Mail's native calendar
(orange-inbox#101). Admin UI at **`/scheduling`**; public booking links at
**`/book/<slug>`**.

## What it does

- Booking links (event types) with weekly availability, buffers, notice,
  booking window, custom intake questions.
- Availability = the **intersection** of free time across every linked
  calendar — Orange-native calendars and/or Google calendars, including
  multiple calendars and multiple people (collective scheduling).
- On booking: writes the event into every linked calendar, mints a Google
  Meet link when configured, links/creates the invitee contact, and emails a
  calendar invite. Self-service reschedule/cancel via tokenized links.

## Required deployment config

### 1. Cloudflare Access — bypass the public paths

The app sits behind Cloudflare Access. The booking pages are public, so add an
Access **Bypass** policy (Everyone) — or a separate hostname — for:

- `/book/*`
- `/api/book/*`

Everything else (`/scheduling`, `/api/scheduling/*`) stays gated. This is the
same constraint the existing `/c/*` and `/d/*` public pages already need.

### 2. D1 migration

`db/migrations/0053_booking.sql` — apply with
`wrangler d1 migrations apply orange-inbox --remote`.

### 3. Google Calendar (optional, needed for Google calendars + Meet)

Create a Google Cloud OAuth client (Calendar API enabled; scopes
`calendar.events` + `calendar.readonly`; redirect URI
`https://<host>/api/scheduling/connections/google/callback`) and set:

```
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

Without these, Google calendars/Meet are unavailable but Orange-native
calendars work fully. OAuth tokens are stored AES-GCM encrypted (key derived
from `INTERNAL_SECRET`).

### 4. Turnstile (optional bot protection)

Set `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET_KEY` (secret) to enable
the challenge on the public booking form. Until set, the form works without it.

## Follow-ups (not in this build)

- Reminder **emails** — the `booking_reminders` table is populated, but the
  cron dispatch isn't wired yet. Both parties already get reminders via the
  calendar invite (`.ics`).
- A nav entry into the inbox shell (the page is reachable at `/scheduling`).
- Zoom / Teams conferencing (orange-inbox#114, #115).
