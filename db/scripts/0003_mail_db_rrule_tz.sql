-- Add rrule + tz to message_calendar_events on existing overflow mail DBs (#89).
--
-- This is a one-shot, manually-applied script — there is NO central tracker
-- for mail-DB migrations (the `d1_migrations` table lives in the control DB
-- and only covers control-DB schema). Run this once against EACH provisioned
-- overflow DB. Newly-bootstrapped overflows get the columns from
-- db/mail-plane-bootstrap.sql so they don't need this script.
--
-- Run via:
--   cd web && npx wrangler d1 execute <mail-db-name> \
--     --remote --file ../db/scripts/0003_mail_db_rrule_tz.sql
--
-- Repeat for every mail DB listed in the control DB's `mail_dbs` table.
--
-- Background:
--   - email-worker/src/ics-parse.ts already extracts rrule + tz on inbound.
--   - email-worker/src/store.ts persists them into message_calendar_events.
--   - web/src/lib/calendar.ts threads them through promoteInvitesForThread
--     into calendar_events.rrule / calendar_events.tz so recurring inbound
--     invites render every occurrence in-window, not just the next one.
--
-- Idempotency: SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so
-- this script will fail with "duplicate column name" if it has already been
-- applied. That's the intended signal — re-run is a no-op via the failure.

ALTER TABLE message_calendar_events ADD COLUMN rrule TEXT;
ALTER TABLE message_calendar_events ADD COLUMN tz    TEXT;
