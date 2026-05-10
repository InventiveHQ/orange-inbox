-- Recurring events (#80).
--
-- Three new columns on calendar_events store the iCalendar repeat rules:
--   rrule  — RFC 5545 RRULE value, sans the "RRULE:" prefix. NULL means
--            "single occurrence" (the existing default semantics for every
--            row that predates this migration).
--   rdate  — Comma-separated unix-seconds list of additional one-off
--            instances to materialise alongside the RRULE expansion.
--   exdate — Comma-separated unix-seconds list of instances to suppress.
--            EXDATE wins over RDATE and over rrule generation.
--
-- We deliberately keep these as text (not JSON arrays / not foreign-keyed
-- override tables) so the unmodified ICS round-trip stays cheap: the
-- email-worker pulls the RRULE straight off the inbound text/calendar
-- attachment and we can re-emit it verbatim from the feed/builder.
-- EXDATE/RDATE serialisation as comma-joined unix seconds keeps SQL-side
-- ops trivial; the expander parses these into a Set on read.
--
-- calendar_event_overrides: per-instance amendments to a recurring series.
-- Keyed on (parent_event_id, original_starts_at) — the unix-seconds value
-- of the *original* untouched expansion is the join key, so an override
-- can move the instance (starts_at/ends_at), retitle it (summary), or
-- cancel it outright (cancelled = 1) without losing the link back to the
-- master rule.
--
-- ON DELETE CASCADE: deleting the master event drops its overrides too;
-- a series cancelled at the parent level shouldn't leave orphan rows
-- pointing into nothing.

ALTER TABLE calendar_events ADD COLUMN rrule  TEXT;
ALTER TABLE calendar_events ADD COLUMN rdate  TEXT;
ALTER TABLE calendar_events ADD COLUMN exdate TEXT;

CREATE TABLE calendar_event_overrides (
  parent_event_id    TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  original_starts_at INTEGER NOT NULL,
  starts_at          INTEGER,
  ends_at            INTEGER,
  summary            TEXT,
  cancelled          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (parent_event_id, original_starts_at)
);

-- The expansion path queries overrides by parent_event_id; the PK above
-- already covers that. No extra index needed.
