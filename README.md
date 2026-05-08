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

## Deploy

```sh
cd web && npm run deploy
cd ../email-worker && npm run deploy
```

Then in the Cloudflare dashboard:

1. Point your domain's Email Routing rule at the deployed `orange-inbox-email`
   Worker. Inbound mail will start landing in D1/R2.
2. Put **Cloudflare Access** in front of `orange-inbox-web` (Zero Trust →
   Applications → Add a self-hosted application). Access takes care of MFA,
   hardware-key login, and SSO; the app trusts the
   `Cf-Access-Authenticated-User-Email` header it injects.

## Roadmap

- [x] Stage 1 — Repo scaffold, schema, configs, control-plane / mail-plane split.
- [x] Stage 2 — Inbound parse + threading.
- [x] Stage 3 — Cloudflare Access auth + "add a mail domain" wizard + three-pane read UI.
- [x] Stage 4 — Compose + send via `env.EMAIL.send()`, identity-aware replies.
- [ ] Stage 5 — Labels, search, identity-aware replies.
- [ ] Stage 6 — One-click deploy button + per-domain role management.

## License

MIT — see [LICENSE](./LICENSE).
