-- Opt-in auto-archive of the marketing/no-action lane (Superhuman-style
-- "Auto Archive"). Off by default — the user turns it on in Settings.
--
-- Two control-DB columns:
--   1. user_preferences.auto_archive_marketing — per-user opt-in. When 1, new
--      inbound threads classified (is_marketing=1, is_action_item=0) for a
--      mailbox this user OWNS are filed straight to archived on ingest, the
--      same way muted/blocked-sender mail is (no unread bump, no push).
--   2. threads_index.auto_archived_at — unix seconds the thread was auto-
--      archived (NULL = not auto-archived). Powers the "N filed in the last
--      day · Review" digest banner and lets the UI distinguish an automatic
--      archive from one the user did by hand (so undo can be offered).
--
-- Reversible: a normal unarchive (or a human reply landing in the thread,
-- which re-surfaces it via the existing forceArchived=false path) clears the
-- thread from the inbox-hidden state; auto_archived_at is left as a historical
-- marker.

ALTER TABLE user_preferences ADD COLUMN auto_archive_marketing INTEGER NOT NULL DEFAULT 0;

ALTER TABLE threads_index ADD COLUMN auto_archived_at INTEGER;

-- Digest query reads recent auto-archives per mailbox; index the timestamp so
-- the daily "what did we file" scan stays a range probe, not a table scan.
CREATE INDEX IF NOT EXISTS threads_index_auto_archived
  ON threads_index(auto_archived_at)
  WHERE auto_archived_at IS NOT NULL;
