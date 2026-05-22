# orange-inbox

A Gmail-like webmail client that runs entirely on Cloudflare. Built for people
who use [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)
and want a real inbox UI instead of forwarding everything to a third party.

> Status: actively developed. The core inbox — receive, read, compose, reply,
> labels, search, scheduled send, undo send, drafts, templates, push
> notifications, PWA install, and Calendly-style meeting booking — is
> working end-to-end. Versions are still 0.2.x; expect rough edges.

## Try it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/InventiveHQ/orange-inbox)

The button forks this repo into your GitHub, creates the D1 / R2 / KV
resources, and deploys both Workers. Two manual steps remain after that:
setting up Cloudflare Access (login) and turning on Email Routing for any
mail-plane domain — both covered in [Post-deploy setup](#post-deploy-setup)
below.

## What it is

- A **Next.js** app deployed to Cloudflare Workers via
  [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) — serves the
  three-pane Gmail-style UI and the API for reading/sending mail.
- A standalone **Email Worker** that Cloudflare Email Routing dispatches each
  inbound message to. It parses MIME, writes raw bytes to R2, and inserts
  thread/message rows into D1.
- **D1** for metadata (a primary "control" DB plus zero-or-more "mail" DBs
  that the primary fills up into — see [Storage and overflow](#storage-and-overflow)),
  **R2** for raw `.eml` and attachments.
- Outbound mail uses the
  [`send_email` binding](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/),
  so SPF/DKIM/DMARC are managed by Cloudflare.
- A **meeting-booking** layer on the native calendar — public, Calendly-style
  booking links with multi-calendar availability and Google Calendar + Meet
  (admin at `/scheduling`; configured in [Post-deploy setup](#post-deploy-setup)).

Multi-domain is a first-class concern: one deployment can serve mail for many
domains, with both a unified inbox and per-domain silos.

## Two kinds of domain

orange-inbox separates the **host domain** (where you sign in) from the **mail
domains** (whose mail you read and send). They don't have to overlap.

| Role | Example | Needs Email Routing? |
| --- | --- | --- |
| Host / control-plane domain — where the app is served, where you authenticate via Cloudflare Access | `orangemail.inventivehq.com` | No |
| Mail-plane domains — Cloudflare Email Routing is enabled on these; the app reads and sends their mail | `glitchreplay.com`, `example.com` | Yes |

You sign in once on the host. From there you add as many mail domains as you
own, each verified through the Cloudflare API. A single user can have
different roles per domain (admin on one, reader on another).

Auth on the host is delegated to **Cloudflare Access** — the Worker trusts the
`Cf-Access-Authenticated-User-Email` header and the signed JWT, so MFA,
hardware keys, and SSO are all handled for free.

## Architecture

```
                  ┌─────────────────────┐
   inbound  ─────►│ email-worker        │──► R2 (raw .eml + attachments)
   (MX → CF)      │  email() handler    │──► D1 (threads + messages)
                  └─────────────────────┘
                         shares
                  ┌─────────────────────┐
   browser  ◄────►│ web (Next.js +      │──► D1 (read)
                  │  OpenNext)          │──► R2 (signed URLs)
                  │  send_email binding │──► outbound SMTP via Cloudflare
                  └─────────────────────┘
```

## Layout

```
orange-inbox/
├── web/                  Next.js 16 + OpenNext for Cloudflare
├── email-worker/         Inbound Email Worker (postal-mime → D1/R2)
├── db/migrations/        D1 SQL migrations (shared by both Workers)
└── README.md
```

## Prerequisites

- Node.js 20.9+
- A Cloudflare account with at least one domain on Email Routing
- `wrangler login` to authenticate

## Setup

For first-time deploys, the [Deploy to Cloudflare button](#try-it) at the top
of this README is the recommended path — it forks the repo, provisions D1 /
R2 / KV, and deploys both Workers in one click.

For power users, re-deploys, or if you want a local clone you can hack on,
one command does everything: install, resource creation, schema, deploy.

```sh
./scripts/setup.sh
```

This is idempotent — every step looks for existing resources before creating
anything. Re-run it any time you pull new migrations or want to redeploy.

If you'd rather do it by hand, see [`scripts/setup.sh`](./scripts/setup.sh) for
the exact wrangler commands; nothing in there is magical.

## Development

The Next.js Worker expects a Cloudflare Access-signed identity header
(`Cf-Access-Authenticated-User-Email`). For `next dev` there's an escape
hatch: set `DEV_USER_EMAIL` in `web/.dev.vars` and the auth helper will
treat that as the signed-in user.

`INTERNAL_SECRET` gates the cron-driven `/api/internal/dispatch-scheduled`
endpoint and must match between the two workers. In prod it's a Cloudflare
Worker secret (provisioned by `scripts/setup.sh`); for local dev, put any
matching value in both `.dev.vars` files.

```sh
cd web
echo 'DEV_USER_EMAIL=you@yourdomain.com' > .dev.vars
echo 'INTERNAL_SECRET=dev-only-secret'   >> .dev.vars
echo 'INTERNAL_SECRET=dev-only-secret'   > ../email-worker/.dev.vars
npm run dev          # Next.js dev server with miniflare-backed bindings
npm run preview      # OpenNext build + workerd preview (matches prod)
```

```sh
cd email-worker
npm run dev          # local Worker with shared D1/R2
```

Open http://localhost:3000 — the app redirects to `/inbox/all` and prompts you
to add your first mail domain through the sidebar button.

## Post-deploy setup

`./scripts/setup.sh` deploys both Workers but the app isn't yet usable —
anyone hitting it gets the "Sign in required" screen and no mail flows. Three
steps in the Cloudflare dashboard wire it together. The first is optional;
the other two are required for an end-to-end inbox.

### 1. Custom domain for the web app (optional but recommended)

The default URL is `<worker-name>.<subdomain>.workers.dev`. Fine for testing,
but you'll want a real host like `mail.example.com`.

1. **Workers & Pages** → click `orange-inbox-web`
2. **Settings** → **Domains & Routes** → **Add → Custom domain**
3. Enter the host you want (`mail.yourdomain.com`). The domain must already
   be on Cloudflare as a zone you control.
4. Save. DNS, TLS, and routing auto-configure within a minute.

This host is independent from any mail-plane domains — the host doesn't need
Email Routing and never receives mail.

### 2. Cloudflare Access (login)

orange-inbox has no password store and no login form. Authentication is
fully delegated to Access — the Worker trusts the
`Cf-Access-Authenticated-User-Email` header that Access injects on every
request. Without Access in front, no header is set and the app shows
"Sign in required".

**Protect the app.**

1. **Zero Trust** → **Access** → **Applications** → **Add an application**
2. Choose **Self-hosted**
3. **Application name:** `orange-inbox`
4. **Application domain:** the custom domain from step 1, or your
   `*.workers.dev` URL. Leave the **path** empty so it covers `/*`.
5. Pick at least one **identity provider**. **One-time PIN** works without
   any setup; Google / GitHub / SAML / OIDC are all options if you want SSO.
6. Add a **policy** — **Action:** Allow, **Configure rules:** e.g.
   `Emails ending in` → `@yourdomain.com`, or a literal email allowlist.
7. Save. Access starts protecting the URL within seconds.

**Open the public paths (required).** Some routes are reached by people and
systems that will never have an Access account — confidential-message
recipients, calendar apps fetching a subscribed feed, and every browser
loading the app's own CSS/JS. If Access covers these, the app breaks:
static assets behind Access fail whenever a session lapses (the UI renders
unstyled), confidential-message recipients hit a login wall, and
calendar/tracking requests can't authenticate at all.

Every dynamic public route lives under one prefix — `/p/*`:

| Path | Reached by |
| --- | --- |
| `/p/c/*`, `/p/api/confidential/*` | recipients opening a confidential message |
| `/p/api/calendar/ics/*` | Google / Apple / Outlook fetching a subscribed calendar feed |
| `/p/api/track/*` | recipients' mail clients loading open-tracking pixels |

So a single Bypass destination — `/p/*` — covers every public route. With
the framework's static assets that totals five destinations, exactly the
per-application limit, so **one** Bypass application is enough. Access
matches the most specific path first, so its destinations coexist with the
`/*` Allow application:

| Application | Destinations | Policy |
| --- | --- | --- |
| `orange-inbox` | `<host>/*` | Allow — your users |
| `orange-inbox-public` | `/p/*`, `/_next/*`, `/sw.js`, `/manifest.webmanifest`, `/*.png` | Bypass — Everyone |

For the Bypass app: add the five paths under **Destinations**, then give it
one policy with **Action: Bypass** and an **Everyone** include rule.
(`/manifest.webmanifest` and `/*.png` are only cosmetic — the PWA manifest
and icons — so drop them if you want destination headroom.)

Exposing these without Access is safe: the static files are content-hashed
build artifacts with no secrets, and each `/p/*` route is guarded by its
own unguessable URL token (plus an optional passcode for confidential
messages) — the token is the credential, not the Access login.

Visit the host URL — you redirect to Access, sign in (PIN or your IdP), and
land back in the app authenticated. The first sign-in lazily creates a row
in the `users` table.

> **MFA / hardware keys:** configured per identity provider in Zero Trust →
> Settings → Authentication. Enabling a TOTP or WebAuthn factor on the
> provider applies automatically to the orange-inbox app.

### 3. Email Routing for a mail-plane domain

For each domain whose mail you want orange-inbox to handle:

1. Cloudflare dashboard → select the domain → **Email** → **Email Routing**
2. **Get started** / **Enable Email Routing**. Cloudflare offers to add the
   needed MX, SPF, and DKIM DNS records — accept that. Wait a minute for
   them to verify.
3. **Routing rules** → either:
   - **Catch-all address** → **Edit** → Action: **Send to a Worker** →
     Destination: `orange-inbox-email` → Save and **enable** the catch-all,
     or
   - Add per-address rules with the same Worker destination.
4. Open the deployed app, sidebar **+ Add mail domain**, enter the same
   domain name. The app creates the `domains` row, a default catch-all
   `mailbox`, and grants you `admin` role on it.

Mail sent to `anything@yourdomain.com` now lands in D1/R2 via the email
Worker. Compose and Reply use the `send_email` binding to send back out —
which works for any domain on your account that has Email Routing active
(step 2 enabled it).

### Verifying it works

```sh
# Tail inbound parse logs while you send yourself a test
cd email-worker && npx wrangler tail
```

Send mail to `anything@yourdomain.com`, watch the tail print the parsed
`from`/`to`/`mailbox`/`thread` IDs, then refresh the app — the thread
appears at the top of the list.

### 4. Scheduling — meeting booking

The booking feature — admin UI at `/scheduling`, public links at
`/p/book/<slug>` — works once migration `0053_booking.sql` is applied.
`./scripts/setup.sh` applies it automatically; or run
`cd web && npx wrangler d1 migrations apply orange-inbox --remote`. The public
booking pages live under `/p/*`, so the step-2 Access Bypass already covers
them — no extra Access config. `/scheduling` and `/api/scheduling/*` (including
the Google OAuth callback) stay gated behind Access as admin-only.

Two integrations are optional:

**Google Calendar + Meet** — lets booking links pull availability from Google
calendars and auto-generate Meet links. Create a Google Cloud OAuth client
(Calendar API enabled; authorized redirect URI
`https://<host>/api/scheduling/connections/google/callback`), then:

```sh
cd web
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Without these, booking links still work with Orange Mail's own calendars —
Google is simply unavailable. OAuth tokens are stored AES-GCM encrypted.

**Turnstile** — bot protection on the public booking form. Set both with
`npx wrangler secret put` (run from `web/`):

```sh
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Until set, the form works without a challenge.

Full reference: [`web/SCHEDULING.md`](./web/SCHEDULING.md).

## Installing on your phone

orange-inbox ships as a Progressive Web App. Once installed it launches with
its own home-screen icon, no browser chrome, and (on supported platforms)
push notifications.

**iPhone / iPad — Safari only.** Chrome and Firefox on iOS can't install
PWAs.

1. Open the host URL (e.g. `https://orangemail.yourdomain.com`) in Safari.
2. Sign in through Cloudflare Access first — the manifest is fetched with
   `crossOrigin="use-credentials"` so the Access cookie has to be present
   when the browser asks for it. If install fails silently, this is almost
   always the cause.
3. Tap the Share button (square with up-arrow) → **Add to Home Screen** →
   **Add**.

**Android — Chrome.**

1. Open the host URL in Chrome and sign in.
2. Tap the install banner if it appears, or open the ⋮ menu →
   **Install app**.

**Push notifications.** Toggle them on at *Settings → Notifications*. The
browser will prompt for permission once. On iOS, push only works after the
app is installed to the home screen (iOS 16.4+) — install first, then open
the installed app and enable from inside it.

In-app help with the same instructions plus walkthroughs for mailboxes,
sharing, compose features, and search lives at *sidebar → Help*
(`/inbox/help`).

## Updating

`./scripts/setup.sh` is the same command for first-time setup and for
updates: it skips resource creation if things already exist and just
applies any new migrations and redeploys both Workers.

## Operational alerts

If something goes wrong server-side — inbound mail fails to parse, the
cron tick crashes, a scheduled send errors out — orange-inbox can post
a structured alert to a Slack-compatible webhook (Discord and most
generic webhook services also accept the same payload).

Set `ALERT_WEBHOOK_URL` as a worker secret on **both** workers:

```sh
read -s ALERT_URL
echo "$ALERT_URL" | (cd web          && npx wrangler secret put ALERT_WEBHOOK_URL)
echo "$ALERT_URL" | (cd email-worker && npx wrangler secret put ALERT_WEBHOOK_URL)
unset ALERT_URL
```

Without the secret, alerts fall back to `console.error` — visible in
`npx wrangler tail` but not pushed anywhere. Set it before launch and
you'll get paged when the inbound MX → email-worker path breaks.

## Storage and overflow

A fresh deploy uses a single D1 database for everything — the simple,
zero-config path. D1 tops out at 10 GB per database, so for a heavy mail
account that fills up over time. orange-inbox handles this by **adding
overflow databases** when the primary nears capacity:

- The primary DB always holds control-plane state (users, mailboxes,
  drafts, contacts, templates, labels, the mail-DB registry, the inbox
  listing index). Bounded data; never moves.
- Each thread is **pinned** at creation time to whichever mail DB had
  capacity. Replies on that thread always route back to the same DB so
  threading never fragments.
- Two soft levers per DB:
  - **Soft cap** (default 8 GB): once crossed, no *new* threads route
    here. Existing threads keep flowing in.
  - **Hard cap** (default 9.5 GB): once crossed, no writes accepted.
    The 1.5 GB cushion is your "expand before this fills" budget.
- A capacity bar in the bottom-left of the sidebar tracks usage live;
  it turns amber at 80 % of soft, red at soft, dark-red at hard.

Adding overflow capacity is one command:

```sh
./scripts/provision-overflow.sh --count 5      # adds 5 mail DBs (≈ 40 GB extra)
cd web && npm run deploy
cd ../email-worker && npx wrangler deploy
```

The script creates each D1, applies the mail-plane bootstrap schema,
patches `wrangler.jsonc` in both workers, and registers the new DBs in
the primary's `mail_dbs` table. The redeploy is required — until then
the new bindings aren't part of the runtime environment.

Full details — schema, routing rules, per-DB capacity tuning,
manual `byte_estimate` refresh — live in
[`db/MAIL_DBS.md`](./db/MAIL_DBS.md).

## Roadmap

- [x] Repo scaffold, schema, configs, control-plane / mail-plane split.
- [x] Inbound parse + threading.
- [x] Cloudflare Access auth + "add a mail domain" wizard + three-pane read UI.
- [x] Compose + send via `env.EMAIL.send()`, identity-aware replies.
- [x] Labels, full-text search, drafts, templates, contacts.
- [x] Scheduled send, undo send, attachments, mailbox signatures.
- [x] Mail-DB overflow sharding.
- [x] PWA install + web push notifications.
- [x] Two-tier roles (Admin/User) + per-mailbox member management.
- [x] Mobile shell + in-app help.
- [x] One-click deploy button.
- [x] Calendly-style meeting booking — multi-calendar availability, Google Calendar + Meet, public booking pages.
- [x] Per-mailbox Kanban board view — customizable columns, drag-to-triage.

## License

MIT — see [LICENSE](./LICENSE).
