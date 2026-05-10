-- Native calendar (closes #77, completes #70).
--
-- #70 shipped inline `.ics` parsing + an RSVP-via-reply card: the email-worker
-- parses inbound `text/calendar` attachments into `message_calendar_events`
-- (mail-DB) and the ThreadView renders Accept/Tentative/Decline buttons.
--
-- This adds the *user-facing* calendar: a per-user store of events that
-- promotes inbound invites once the user opens the thread, plus self-created
-- events. The page at /inbox/calendar reads from here with day/week/month
-- views.
--
-- Lives in control DB. Calendar state is per-user (shared mailboxes have
-- multiple users who each want their own RSVP state, hence user_id FK rather
-- than mailbox_id). No mail-DB / bootstrap.sql change — message_calendar_events
-- continues to be the ingest-time landing zone.
--
-- Promotion strategy is lazy: when a user opens a thread that contains a
-- message with a calendar invite, the web worker INSERTs a row here if one
-- doesn't already exist for (user_id, ical_uid). Idempotent — repeat opens
-- are no-ops. The unique partial index below enforces the dedupe.
--
-- CANCEL handling: when an inbound message arrives with METHOD=CANCEL, the
-- email-worker flips `cancelled` to 1 on every matching `ical_uid` row across
-- users so the event stays visible (strikethrough) but is unambiguously dead.

CREATE TABLE calendar_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ical_uid          TEXT,                              -- NULL for source='self' v1
  source            TEXT NOT NULL CHECK (source IN ('invite','self','imported')),
  source_message_id TEXT,                              -- mail-DB message id; NOT FK-enforced
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER,
  all_day           INTEGER NOT NULL DEFAULT 0,
  summary           TEXT,
  location          TEXT,
  description       TEXT,
  organizer_email   TEXT,
  rsvp_status       TEXT CHECK (rsvp_status IN ('NEEDS-ACTION','ACCEPTED','TENTATIVE','DECLINED')),
  rsvp_sent_at      INTEGER,
  cancelled         INTEGER NOT NULL DEFAULT 0,
  raw_ics           TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX calendar_events_user_starts ON calendar_events(user_id, starts_at);
CREATE UNIQUE INDEX calendar_events_user_uid
  ON calendar_events(user_id, ical_uid) WHERE ical_uid IS NOT NULL;
