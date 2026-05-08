# db

D1 schema for orange-inbox. Both `web/` and `email-worker/` point their
`migrations_dir` at `./migrations` so either Worker can apply them.

## Create the database

```sh
cd ../web   # or email-worker, doesn't matter — they share the DB
npx wrangler d1 create orange-inbox
```

Wrangler prints a `database_id`. Paste it into both `web/wrangler.jsonc` and
`email-worker/wrangler.jsonc` (replace `REPLACE_WITH_D1_ID`).

## Apply migrations

Local (miniflare-backed):

```sh
npx wrangler d1 migrations apply orange-inbox --local
```

Remote:

```sh
npx wrangler d1 migrations apply orange-inbox --remote
```

## Adding a migration

Number files monotonically (`0002_…sql`, `0003_…sql`). Wrangler tracks applied
ones in a `d1_migrations` table — never edit a migration that's already shipped.
