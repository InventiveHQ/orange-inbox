-- Undo send. Builds on 0008_scheduling.sql: when the user has a non-zero
-- undo_send_seconds, the compose flow queues outgoing mail through
-- scheduled_messages with kind='undo_send' and scheduled_for = now + delay.
-- The user gets a countdown toast with an Undo button while the row is
-- pending; cron picks it up after the delay and dispatches it normally.
--
-- Rows with kind='undo_send' are hidden from the Scheduled view (they're
-- transient — typically 5–30s) but otherwise share the same pipeline.

PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN undo_send_seconds INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scheduled_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'scheduled'
  CHECK (kind IN ('scheduled','undo_send'));
