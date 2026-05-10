-- Per-event time zones (#82).
--
-- Two columns:
--   calendar_events.tz — IANA zone (e.g. "America/Los_Angeles"). NULL
--     keeps the existing "floating" semantics (interpret in the viewer's
--     local zone) so every row that predates this migration still
--     renders the same as before.
--   users.default_tz — the zone new self events fall back to when the
--     form's tz picker isn't explicitly set. Lives on the user (not the
--     device) so a traveller doesn't accidentally schedule "11am" in the
--     wrong zone just because their laptop clock followed them.
--
-- starts_at / ends_at remain unix UTC seconds — `tz` is purely a display
-- + RRULE-DST-resolution hint. Grids convert to viewer-tz at render time;
-- the new "scheduled for {tz}" badge is suppressed when tz matches the
-- viewer or is NULL.

ALTER TABLE calendar_events ADD COLUMN tz TEXT;
ALTER TABLE users ADD COLUMN default_tz TEXT;
