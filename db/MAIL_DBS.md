# Mail database overflow

orange-inbox can run on a single D1 database (the default) or fan out
across many. Reading this doc end-to-end takes ~5 minutes.

## When to expand

D1's hard ceiling is 10 GB per database. We pre-empt that with two soft
levers per database:

- **soft cap** (default 8 GB) — when crossed, the DB stops accepting
  *new threads*. Existing threads keep flowing in (replies, inbound
  follow-ups) so conversations don't fragment across DBs.
- **hard cap** (default 9.5 GB) — when crossed, the DB rejects all
  writes. The 1.5 GB cushion between caps is your "we have to expand
  before this fills" budget.

The capacity bar in the bottom-left of the sidebar is the operational
signal. Colors:

| State | Trigger | What it means |
|-------|---------|---------------|
| neutral | < 80 % of soft | nothing to do |
| amber | ≥ 80 % of soft | start planning to expand |
| red | ≥ soft | new threads going elsewhere; existing conversations still land here |
| dark red | ≥ hard | the DB is sealed; if no other DB has room, mail is rejected |

## Provisioning overflow

Use the helper script — it creates the D1, applies the mail-plane
schema, patches both `wrangler.jsonc` files, and registers the new DB
in `mail_dbs`. Pass `--count N` for multiple DBs in one go.

```sh
./scripts/provision-overflow.sh --count 5
```

Then redeploy both workers (the script reminds you):

```sh
cd web && npm run deploy
cd ../email-worker && npx wrangler deploy
```

Until you redeploy, the new bindings aren't part of the runtime
environment, so any write that routes to one of them will fail with
`wrangler binding env.MAIL_DB_N is not configured`.

## Architecture

The control plane (users, mailboxes, drafts, contacts, templates,
labels, scheduled messages, mail-DB registry) lives in the *primary*
DB forever — bounded data, never moves. The mail plane (threads,
messages, attachments, FTS) starts in primary too; overflow DBs hold
*only* mail-plane tables.

Every thread is **pinned** to whichever mail DB it was created in via
the `thread_locations` row (omitted for primary so a single-DB deploy
never writes there). Replies on that thread always route back to the
same DB — threading never fragments.

Listing reads from `threads_index` in control, which mirrors the few
fields the inbox view needs (snippet, last-from, message_count,
unread_count, etc.). The listing query is one SQL no matter how many
overflow DBs exist.

## Routing rules

- **Inbound mail (email-worker)**:
  - Existing thread (matched via Message-ID/References across active
    DBs, then subject fallback): write to that thread's mail DB.
  - New thread: pick the active mail DB with the smallest
    `byte_estimate` that's still under its soft cap. Falls back to
    "under hard cap" in degraded mode so we keep accepting mail past
    the soft threshold.
  - Updates `threads_index` and `thread_locations` (only if non-primary).
- **Outbound mail (`/api/messages`)**:
  - Same rules. Replies use the parent's DB; new threads pick.

## Schema reference

`mail_dbs` (control DB):

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | `'primary'` or operator-chosen, e.g. `'mail_3'` |
| `binding_name` | TEXT | env binding; matches `wrangler.jsonc` |
| `display_name` | TEXT | UI label |
| `soft_max_bytes` | INTEGER | start steering new threads elsewhere when reached |
| `hard_max_bytes` | INTEGER | refuse all writes when reached |
| `byte_estimate` | INTEGER | last-computed size; updated by the cron |
| `active` | INTEGER | 1 = accept new threads; 0 = sealed |

`thread_locations` (control DB): `(thread_id, mail_db_id)`. Missing row
implies `'primary'`.

`threads_index` (control DB): per-thread denorm with the listing
fields. Maintained by the send + email-worker write paths.

`thread_labels` (control DB): cache of `(thread_id, label_id)` for the
listing label chips. Populated alongside `message_labels` writes.

## Updating capacity numbers

`mail_dbs.byte_estimate` is updated by a cron (TODO — currently
defaults to 0). Until that lands, the capacity bar shows 0% used.
Manual refresh:

```sh
# Compute a rough size from message bodies (this is the cheap proxy;
# real sizes are bigger because of FTS index overhead and metadata).
npx wrangler d1 execute orange-inbox --remote --command "
  UPDATE mail_dbs SET byte_estimate = (
    SELECT COALESCE(SUM(LENGTH(text_body)), 0) FROM messages
  ) WHERE id = 'primary';
"
```

Per-DB queries against the overflow DBs work the same way with
`--name <overflow-name>`.

## Limitations (Phase 1 scope)

- Search currently runs against the primary DB only — overflow DBs
  aren't part of the FTS fan-out yet. Threads in overflow are still
  visible in the inbox listing but won't show up in search results.
- `byte_estimate` isn't auto-updated; capacity bar is accurate only
  after a manual refresh until the cron lands.
- Provisioning script edits `wrangler.jsonc` with awk; if you have
  unusual formatting (comments inside the d1_databases array,
  trailing commas in unexpected places), inspect the diff before
  redeploying.
