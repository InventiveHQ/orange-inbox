-- Snooze (per-thread) and scheduled send (per-message-to-be).
--
-- Both rely on a single cron in the email-worker that ticks once a minute,
-- unsnoozes due threads, and dispatches due scheduled_messages back to the
-- web worker via a service binding. Keeping the data here in D1 (rather than
-- a separate Queue) means cancel/list operations are trivial.

PRAGMA foreign_keys = ON;

-- threads.snoozed_until: unix seconds when the thread should re-appear in
-- the inbox. NULL = not snoozed. listThreads filters out anything where
-- snoozed_until > now(), and the cron clears values that have passed.
ALTER TABLE threads ADD COLUMN snoozed_until INTEGER;
CREATE INDEX threads_snoozed ON threads(snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- One row per scheduled outbound. payload_json is the same shape POSTed to
-- /api/messages (the SendInput, JSON-stringified) — kept verbatim so the
-- dispatcher can re-use the existing send pipeline without translation.
CREATE TABLE scheduled_messages (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for  INTEGER NOT NULL,           -- unix seconds, due-time
  payload_json   TEXT NOT NULL,              -- JSON of /api/messages POST body
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','failed','cancelled')),
  error_message  TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at        INTEGER
);

CREATE INDEX scheduled_messages_due
  ON scheduled_messages(status, scheduled_for)
  WHERE status = 'pending';

CREATE INDEX scheduled_messages_user
  ON scheduled_messages(user_id, scheduled_for DESC);
