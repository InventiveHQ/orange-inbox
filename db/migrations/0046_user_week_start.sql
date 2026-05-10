-- Per-user week-start preference (#87).
--
-- Calendar grids historically rendered Sunday-first regardless of locale.
-- ISO-8601 locales (most of Europe, plus folks who think in work-weeks)
-- prefer Monday. Stored as an integer to leave room for "any day" later
-- without ever needing another migration — Saturday-first calendars are
-- a thing in parts of the Middle East.
--
-- Values: 0 = Sunday (US default), 1 = Monday (ISO).
ALTER TABLE users ADD COLUMN week_start_day INTEGER NOT NULL DEFAULT 0;
