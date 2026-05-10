-- Per-mailbox calendars (closes #78).
--
-- Today calendar_events is keyed only on user_id — every row a user can see
-- gets stacked into a single Personal calendar. This migration attributes
-- each row back to the mailbox it came from (NULL = "Personal" — pre-existing
-- rows + self events not bound to a mailbox), and adds a per-user prefs
-- table for color / show-hide toggles. Consolidated view = "every calendar
-- visible".
--
-- Lives in control DB. No mail-DB / bootstrap.sql change — calendar_events
-- has always been per-user / control-side, message_calendar_events (mail-DB)
-- continues to be the ingest landing zone unchanged.
--
-- BACKFILL NOTE: existing invite rows (source='invite') carry a
-- source_message_id pointing at messages in a mail DB. Setting their
-- mailbox_id correctly would mean joining cross-DB to mail-plane
-- messages.mailbox_id, which D1 can't do in a single migration. We leave
-- those rows with mailbox_id=NULL ("Personal") and rely on the runtime
-- promotion path (promoteInvitesForThread + threadView caller) to populate
-- mailbox_id on every subsequent thread-open. Invite rows the user has
-- already promoted will appear in Personal until the user re-opens the
-- thread; after that the row's mailbox_id is filled in idempotently. Self
-- events stay where they are (their original creators didn't pick a
-- mailbox). A heavier backfill is possible later but isn't worth the
-- cross-DB plumbing for v1.

ALTER TABLE calendar_events ADD COLUMN mailbox_id TEXT;

-- Drives the per-mailbox listing path: WHERE user_id = ? AND mailbox_id IS ?
-- ORDER BY starts_at. NULL mailbox_id (Personal) sorts in the same index
-- thanks to SQLite's NULLS-FIRST default.
CREATE INDEX calendar_events_user_mailbox_starts
  ON calendar_events(user_id, mailbox_id, starts_at);

-- Per-user calendar appearance preferences. One row per (user_id, mailbox_id)
-- pair the user has touched; absence implies the defaults below. mailbox_id
-- IS NULL is the "Personal" calendar — a user always has at least that one.
--
-- Note SQLite treats NULL as distinct in PRIMARY KEY, but a user can only
-- ever insert one Personal row because the API normalises NULL to NULL on
-- write and we INSERT … ON CONFLICT DO UPDATE on the upsert. The control
-- code (web/src/lib/calendar.ts) is the source of truth for that contract.
CREATE TABLE user_calendar_prefs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id TEXT,                                 -- NULL = "Personal"
  color      TEXT NOT NULL DEFAULT '#3b82f6',      -- hex; UI swatch + eventTone
  hidden     INTEGER NOT NULL DEFAULT 0,           -- 1 = filtered out by default
  PRIMARY KEY (user_id, mailbox_id)
);
