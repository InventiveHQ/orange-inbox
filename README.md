# orange-inbox

A Gmail-like webmail client that runs entirely on Cloudflare. Built for people
who use [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)
and want a real inbox UI instead of forwarding everything to a third party.

> Status: pre-alpha scaffold. The repo lays out the architecture; features are
> being added in stages.

## What it is

- A **Next.js** app deployed to Cloudflare Workers via
  [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) — serves the
  three-pane Gmail-style UI and the API for reading/sending mail.
- A standalone **Email Worker** that Cloudflare Email Routing dispatches each
  inbound message to. It parses MIME, writes raw bytes to R2, and inserts
  thread/message rows into D1.
- **D1** for metadata, **R2** for raw `.eml` and attachments, **KV** for drafts.
- Outbound mail uses the
  [`send_email` binding](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/),
  so SPF/DKIM/DMARC are managed by Cloudflare.

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

One command does everything: install, resource creation, schema, deploy.

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

```sh
cd web
echo 'DEV_USER_EMAIL=you@yourdomain.com' > .dev.vars
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

1. **Zero Trust** → **Access** → **Applications** → **Add an application**
2. Choose **Self-hosted**
3. **Application name:** `orange-inbox`
4. **Application domain:** the custom domain from step 1, or your
   `*.workers.dev` URL
5. Pick at least one **identity provider**. **One-time PIN** works without
   any setup; Google / GitHub / SAML / OIDC are all options if you want SSO.
6. Add a **policy**:
   - **Action:** Allow
   - **Configure rules:** e.g. `Emails ending in` → `@yourdomain.com`, or
     a literal email allowlist for a single user
7. Save. Access starts protecting the URL within seconds.

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

## Updating

`./scripts/setup.sh` is the same command for first-time setup and for
updates: it skips resource creation if things already exist and just
applies any new migrations and redeploys both Workers.

## Roadmap

- [x] Stage 1 — Repo scaffold, schema, configs, control-plane / mail-plane split.
- [x] Stage 2 — Inbound parse + threading.
- [x] Stage 3 — Cloudflare Access auth + "add a mail domain" wizard + three-pane read UI.
- [x] Stage 4 — Compose + send via `env.EMAIL.send()`, identity-aware replies.
- [ ] Stage 5 — Labels, search, identity-aware replies.
- [ ] Stage 6 — One-click deploy button + per-domain role management.

## License

MIT — see [LICENSE](./LICENSE).
