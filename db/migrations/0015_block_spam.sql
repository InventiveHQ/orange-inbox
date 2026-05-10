-- Block sender + spam reporting (issue #74).
--
-- Two pieces:
--   1. blocked_senders — control-plane table. (mailbox_id, addr) is the
--      block. Mail ingestion checks this on every inbound; matches land
--      archived+muted from the start (we don't drop, so the user can
--      audit and unblock).
--   2. messages.spam_reported_by_user_id — per-message flag set by the
--      "Report spam" UI action. Becomes the labelled corpus for any
--      future heuristics / classifier.
--
-- Address matching is case-insensitive — we lowercase on insert and
-- lowercase parsed.from.addr at the comparison site, so the UNIQUE
-- key works as expected.
--
-- ─── Mail-plane note ─────────────────────────────────────────────────────
-- The ALTER below only runs on the primary D1 (the one with migrations_dir
-- in wrangler.jsonc). Overflow mail DBs are bootstrapped separately from
-- db/mail-plane-bootstrap.sql and don't track migrations. After deploying
-- this change, run the ALTER manually against each overflow DB:
--
--   for n in 1 2 3 …; do
--     npx wrangler d1 execute "orange-inbox-mail-$n" --remote \
--       --command "ALTER TABLE messages ADD COLUMN spam_reported_by_user_id TEXT;"
--   done
--
-- New overflow DBs provisioned after this migration get the column from
-- the bootstrap, no manual step needed.

CREATE TABLE blocked_senders (
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  addr        TEXT NOT NULL,
  blocked_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (mailbox_id, addr)
);

ALTER TABLE messages ADD COLUMN spam_reported_by_user_id TEXT;
CREATE INDEX messages_spam_reported
  ON messages(spam_reported_by_user_id)
  WHERE spam_reported_by_user_id IS NOT NULL;
