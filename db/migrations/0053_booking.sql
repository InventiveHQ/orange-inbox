-- Meeting booking / scheduling — a Calendly-style booking layer on top of the
-- native calendar (orange-inbox#101). A host publishes a booking link
-- (booking_event_types); a visitor picks an open slot on the public page; the
-- booking writes a calendar event into every linked calendar and emails an
-- invite.
--
-- Numbering: 0052 is reserved for the in-flight security-fixes branch
-- (0052_label_owner.sql); this feature starts at 0053. A gap is harmless —
-- the D1 migration runner applies any not-yet-applied file in lexical order.
--
-- Everything here is additive: new tables only, no change to existing mail or
-- calendar tables. calendar_events rows created by a booking are ordinary
-- self-events (source = 'self'); booking_calendar_events ties them back so a
-- reschedule/cancel can update every calendar a booking touched.

-- ---------------------------------------------------------------------------
-- booking_event_types — one row per booking link. The weekly availability and
-- conferencing config live here as JSON to keep the table count down; only
-- date-specific overrides get their own table.
-- ---------------------------------------------------------------------------
CREATE TABLE booking_event_types (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug                   TEXT NOT NULL UNIQUE,          -- public URL: /book/<slug>
  name                   TEXT NOT NULL,
  description            TEXT,
  duration_minutes       INTEGER NOT NULL,
  timezone               TEXT NOT NULL,                 -- IANA tz the schedule is expressed in
  -- Weekly rules: JSON array of {day:0-6 (0=Sun), start:"HH:MM", end:"HH:MM"}.
  availability_json      TEXT NOT NULL DEFAULT '[]',
  buffer_before_minutes  INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes   INTEGER NOT NULL DEFAULT 0,
  min_notice_minutes     INTEGER NOT NULL DEFAULT 0,    -- earliest a slot may be booked
  booking_window_days    INTEGER NOT NULL DEFAULT 60,   -- how far ahead bookings are allowed
  slot_interval_minutes  INTEGER NOT NULL DEFAULT 30,   -- granularity of offered start times
  -- Conferencing (orange-inbox#112): none | google_meet | phone | in_person | custom_link.
  conferencing_type      TEXT NOT NULL DEFAULT 'none',
  conferencing_config_json TEXT,                        -- {"value":"..."} for phone/address/custom URL
  -- Custom intake questions: JSON array of {id,label,type,required}.
  custom_questions_json  TEXT NOT NULL DEFAULT '[]',
  color                  TEXT,
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at             INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX booking_event_types_user ON booking_event_types(user_id);

-- ---------------------------------------------------------------------------
-- booking_availability_overrides — date-specific exceptions to the weekly
-- schedule. available = 0 blocks the whole day; available = 1 replaces it with
-- ranges_json.
-- ---------------------------------------------------------------------------
CREATE TABLE booking_availability_overrides (
  id             TEXT PRIMARY KEY,
  event_type_id  TEXT NOT NULL REFERENCES booking_event_types(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,                         -- "YYYY-MM-DD" in the event type's tz
  available      INTEGER NOT NULL DEFAULT 0,
  ranges_json    TEXT,                                  -- [{start,end}] when available = 1
  UNIQUE (event_type_id, date)
);

-- ---------------------------------------------------------------------------
-- calendar_connections — an external (Google) calendar connected for
-- availability and/or booking writes. OAuth tokens are AES-GCM encrypted at
-- rest (lib/crypto.ts). owner_user_id may differ per row so a coworker's
-- calendar can be added to a collective booking link (orange-inbox#108/#111).
-- ---------------------------------------------------------------------------
CREATE TABLE calendar_connections (
  id                   TEXT PRIMARY KEY,
  owner_user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'google',
  account_email        TEXT NOT NULL,
  calendar_id          TEXT NOT NULL DEFAULT 'primary',
  display_name         TEXT,
  access_token_enc     TEXT,
  refresh_token_enc    TEXT,
  token_expires_at     INTEGER,
  status               TEXT NOT NULL DEFAULT 'active',  -- active | revoked | error
  last_error           TEXT,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (owner_user_id, provider, account_email, calendar_id)
);
CREATE INDEX calendar_connections_owner ON calendar_connections(owner_user_id);

-- ---------------------------------------------------------------------------
-- booking_event_type_calendars — the set of calendars a booking link spans
-- (orange-inbox#111). source_kind picks the columns that apply:
--   orange_native → orange_user_id (+ optional orange_mailbox_id; NULL = that
--                   user's Personal calendar)
--   google        → calendar_connection_id
-- check_availability: this calendar's busy time reduces offered slots.
-- write_bookings:    the confirmed booking is written into this calendar.
-- ---------------------------------------------------------------------------
CREATE TABLE booking_event_type_calendars (
  id                     TEXT PRIMARY KEY,
  event_type_id          TEXT NOT NULL REFERENCES booking_event_types(id) ON DELETE CASCADE,
  source_kind            TEXT NOT NULL,                 -- 'orange_native' | 'google'
  orange_user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  orange_mailbox_id      TEXT,                          -- NULL = Personal calendar
  calendar_connection_id TEXT REFERENCES calendar_connections(id) ON DELETE CASCADE,
  check_availability     INTEGER NOT NULL DEFAULT 1,
  write_bookings         INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX booking_event_type_calendars_event ON booking_event_type_calendars(event_type_id);

-- ---------------------------------------------------------------------------
-- bookings — a confirmed (or cancelled/rescheduled) booking. reschedule_token
-- and cancel_token are unguessable opaque strings used by the public
-- self-service pages so an invitee needs no login.
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id                       TEXT PRIMARY KEY,
  event_type_id            TEXT NOT NULL REFERENCES booking_event_types(id) ON DELETE CASCADE,
  host_user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id               TEXT,                        -- contacts(id); best-effort link
  invitee_name             TEXT NOT NULL,
  invitee_email            TEXT NOT NULL,
  invitee_timezone         TEXT,
  starts_at                INTEGER NOT NULL,
  ends_at                  INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled | rescheduled
  answers_json             TEXT,
  conference_provider      TEXT,
  conference_url           TEXT,
  conference_join_info_json TEXT,
  reschedule_token         TEXT NOT NULL UNIQUE,
  cancel_token             TEXT NOT NULL UNIQUE,
  cancellation_reason      TEXT,
  rescheduled_to_id        TEXT,                        -- bookings(id) of the replacement
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX bookings_event_type ON bookings(event_type_id);
CREATE INDEX bookings_host ON bookings(host_user_id);
CREATE INDEX bookings_starts ON bookings(starts_at);

-- ---------------------------------------------------------------------------
-- booking_calendar_events — a booking writes one event into each write_bookings
-- calendar; one row per written event so reschedule/cancel can fan out.
-- ---------------------------------------------------------------------------
CREATE TABLE booking_calendar_events (
  id                       TEXT PRIMARY KEY,
  booking_id               TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  source_kind              TEXT NOT NULL,               -- 'orange_native' | 'google'
  orange_calendar_event_id TEXT,                        -- calendar_events(id)
  calendar_connection_id   TEXT,                        -- calendar_connections(id), google
  google_event_id          TEXT,
  created_at               INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX booking_calendar_events_booking ON booking_calendar_events(booking_id);

-- ---------------------------------------------------------------------------
-- booking_reminders — due-table polled by the email-worker cron (mirrors the
-- calendar_event_reminders / calendar_reminders_sent pattern). One row per
-- (booking, minutes_before); sent_at is set once dispatched.
-- ---------------------------------------------------------------------------
CREATE TABLE booking_reminders (
  id             TEXT PRIMARY KEY,
  booking_id     TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  remind_at      INTEGER NOT NULL,
  sent_at        INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX booking_reminders_due ON booking_reminders(remind_at) WHERE sent_at IS NULL;
