-- Per-user calendar sort order (#97).
--
-- Powers the drag-to-reorder UX in the calendar sidebar — same shape as
-- user_mailbox_access.sort_order from #52. A user always sees Personal +
-- every mailbox they have access to, but the order of those rows in the
-- left rail is now their own.
--
-- Default 0 = "unordered", which keeps the legacy behaviour (Personal
-- first, mailboxes alphabetical by name). The first drag writes 1..N over
-- every existing row so the list becomes deterministic; new mailboxes
-- granted to the user later get sort_order = 0 and fall through to the
-- alphabetical tail.
--
-- Stored on user_calendar_prefs because the existing table already has a
-- row per (user, calendar) the user has touched, and we materialise a row
-- on first reorder anyway. No schema change to upsertCalendarPref needed
-- for color/hidden writes — the column has a DEFAULT, so old INSERTs that
-- don't mention sort_order still work.

ALTER TABLE user_calendar_prefs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
