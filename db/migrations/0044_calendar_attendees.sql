-- Self-event attendees + REPLY round-trip (#81).
--
-- The companion side of inbound RSVP-handling: when the user creates a self
-- event with attendees, we both ship a `text/calendar; method=REQUEST` and
-- track the recipient list here so an inbound REPLY can flip the matching
-- row's rsvp_status without leaking into the user-RSVP code path.
--
-- (event_id, email) is the natural key — RFC 5545 ATTENDEE lines key off
-- the mailto address. `email` is stored lowercased on insert so case-
-- insensitive REPLY matching can compare verbatim.
--
-- role mirrors RFC 5545's ROLE parameter. We don't enforce a CHECK because
-- Microsoft calendars sometimes send custom values; we just store-and-show.
--
-- rsvp_status defaults to NEEDS-ACTION on insert — same vocabulary as the
-- user-side calendar_events.rsvp_status column, so the form rendering can
-- share helpers.
--
-- ON DELETE CASCADE: deleting the parent event drops the attendee rows.

CREATE TABLE calendar_event_attendees (
  event_id     TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT,            -- REQ-PARTICIPANT | OPT-PARTICIPANT | CHAIR
  rsvp_status  TEXT,            -- NEEDS-ACTION | ACCEPTED | TENTATIVE | DECLINED
  responded_at INTEGER,
  PRIMARY KEY (event_id, email)
);

-- REPLY routing in the email-worker uses (ical_uid → event_id → email)
-- to flip rsvp_status. The ical_uid lookup is on calendar_events directly
-- (already covered by calendar_events_user_uid), then the join to this
-- table is by event_id which the PK serves.
CREATE INDEX calendar_event_attendees_event ON calendar_event_attendees(event_id);
