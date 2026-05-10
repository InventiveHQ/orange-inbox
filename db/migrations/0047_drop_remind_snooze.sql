-- Drop the dangling Remind/Snooze schema after the feature removal.
--
-- Counterpart to the earlier code cleanup that removed SnoozeButton,
-- RemindButton, the snooze API route, the unsnooze cron, and every read/write
-- of these columns. The columns were left in place pending this migration.
--
-- This migration targets the primary DB, where control + mail-plane tables
-- coexist. For deployments that have provisioned OVERFLOW mail DBs, their
-- `threads.snoozed_until` columns remain in place — apply
--   DROP INDEX IF EXISTS threads_snoozed;
--   ALTER TABLE threads DROP COLUMN snoozed_until;
-- manually against each overflow DB to clean those up too. The application
-- code no longer touches these columns, so leaving them is harmless.

-- Control DB: threads_index.remind_at (added 0020) + threads_index.snoozed_until (added 0009).
DROP INDEX IF EXISTS threads_index_remind;
ALTER TABLE threads_index DROP COLUMN remind_at;
ALTER TABLE threads_index DROP COLUMN snoozed_until;

-- Mail-plane threads.snoozed_until + its index (added 0008). Primary-DB
-- copies — overflow DBs need the manual cleanup noted above.
DROP INDEX IF EXISTS threads_snoozed;
ALTER TABLE threads DROP COLUMN snoozed_until;
