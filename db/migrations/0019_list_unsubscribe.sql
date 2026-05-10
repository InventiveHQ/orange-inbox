-- Newsletter management: List-Unsubscribe ingestion (issues #18, #76).
--
-- Two RFCs are in play:
--   * RFC 2369 — `List-Unsubscribe: <https://…>, <mailto:…>` advertises an
--     unsubscribe destination. Either or both may appear; angle brackets are
--     mandatory; multiple URLs are comma-separated.
--   * RFC 8058 — `List-Unsubscribe-Post: List-Unsubscribe=One-Click` opts the
--     sender into one-click unsubscribe. When present alongside an https
--     URL, the receiver may POST `List-Unsubscribe=One-Click` to that URL
--     and treat 2xx as success without rendering the destination.
--
-- We extract these at ingest time so listing/aggregation queries don't have
-- to re-parse headers, and so the Subscriptions page (#76) can build a
-- per-sender summary cheaply via GROUP BY.
--
-- list_unsub_url     — the first https URL found in List-Unsubscribe, or NULL.
-- list_unsub_mailto  — the first mailto URL found, or NULL. Either column or
--                      both can be set; we prefer the URL for actioning but
--                      keep the mailto as a fallback.
-- list_unsub_one_click — 1 if List-Unsubscribe-Post advertises one-click
--                      AND we have an https URL to POST to. The Unsubscribe
--                      action skips the user's browser entirely in that case.
-- unsubscribed_at   — unixepoch when the user (or a bulk action) successfully
--                      unsubscribed via the in-app button. Idempotency guard:
--                      a non-NULL value flips the chip to "Unsubscribed" and
--                      short-circuits the API.
--
-- ─── Mail-plane note ─────────────────────────────────────────────────────
-- The ALTERs below only run on the primary D1 (the one with migrations_dir
-- in wrangler.jsonc). Overflow mail DBs are bootstrapped separately from
-- db/mail-plane-bootstrap.sql and don't track migrations. After deploying
-- this change, run the ALTERs manually against each overflow DB:
--
--   for n in 1 2 3 …; do
--     npx wrangler d1 execute "orange-inbox-mail-$n" --remote \
--       --command "ALTER TABLE messages ADD COLUMN list_unsub_url TEXT;
--                  ALTER TABLE messages ADD COLUMN list_unsub_mailto TEXT;
--                  ALTER TABLE messages ADD COLUMN list_unsub_one_click INTEGER NOT NULL DEFAULT 0;
--                  ALTER TABLE messages ADD COLUMN unsubscribed_at INTEGER;"
--   done
--
-- New overflow DBs provisioned after this migration get the columns from
-- the bootstrap, no manual step needed.

ALTER TABLE messages ADD COLUMN list_unsub_url TEXT;
ALTER TABLE messages ADD COLUMN list_unsub_mailto TEXT;
ALTER TABLE messages ADD COLUMN list_unsub_one_click INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN unsubscribed_at INTEGER;

-- Partial index so the Subscriptions page's "messages with an unsubscribe
-- mechanism" filter is index-backed. unsubscribed_at filtering is left to
-- the row scan — typical row count under the partial index is small.
CREATE INDEX messages_list_unsub
  ON messages(mailbox_id, from_addr)
  WHERE list_unsub_url IS NOT NULL OR list_unsub_mailto IS NOT NULL;
