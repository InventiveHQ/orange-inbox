-- Inline calendar invites (closes #70). When an inbound message arrives with
-- a `text/calendar` (.ics) attachment, the email-worker parses the VEVENT and
-- writes a row here keyed on the message id. The reader UI joins this table
-- in `getThreadDetail` so the calendar card can render above the body without
-- a second round-trip.
--
-- Applies to mail DBs (lives next to messages). For existing overflows: run
--
--   CREATE TABLE message_calendar_events (
--     message_id TEXT PRIMARY KEY,
--     starts_at  INTEGER NOT NULL,
--     ends_at    INTEGER,
--     summary    TEXT,
--     location   TEXT,
--     organizer  TEXT,
--     uid        TEXT,
--     method     TEXT,
--     raw_ics    TEXT NOT NULL
--   );
--   CREATE INDEX message_calendar_events_starts ON message_calendar_events(starts_at DESC);
--
-- manually. New overflows get this from db/mail-plane-bootstrap.sql (also
-- updated in this commit).

CREATE TABLE message_calendar_events (
  message_id TEXT PRIMARY KEY,           -- references messages(id) but not enforced (mail-DB)
  starts_at  INTEGER NOT NULL,           -- unix seconds
  ends_at    INTEGER,
  summary    TEXT,
  location   TEXT,
  organizer  TEXT,                       -- email
  uid        TEXT,                       -- iCal UID, used for reply correlation
  method     TEXT,                       -- REQUEST | CANCEL | REPLY | PUBLISH
  raw_ics    TEXT NOT NULL               -- full source for re-parsing if we expand
);
CREATE INDEX message_calendar_events_starts ON message_calendar_events(starts_at DESC);
