-- Header: messages.tracking_token lives in mail DBs (existing table).
-- message_read_events lives in control DB (per-user analytics).
-- Bootstrap.sql needs the messages column.
--
-- #69 — opt-in read receipts.
--
-- When the sender toggles "Track opens" on the composer, we mint a per-
-- message tracking_token and inject a 1x1 transparent PNG <img> referencing
-- /api/track/<token>.png into the outbound HTML body. Each fetch of that
-- image records a row in message_read_events; the reader UI surfaces a
-- "Read N times — last opened {when}" pill on outbound messages whose
-- tracking_token is non-null.
--
-- This migration affects BOTH databases:
--   1. messages.tracking_token — lives in the mail DBs (the same DB that
--      holds the message row). The bootstrap.sql add is the source of truth
--      for fresh overflow DBs; this file alters the primary mail-DB schema
--      that ships inside the control DB during initial provisioning.
--   2. message_read_events — lives in CONTROL only. Open events are
--      cross-mailbox per-user analytics and never need to follow a thread
--      between mail DBs, so we don't bother sharding them.
--   3. user_preferences.default_track_opens — control DB, defaults the
--      composer toggle in Settings → Sending.

ALTER TABLE messages ADD COLUMN tracking_token TEXT;

CREATE TABLE message_read_events (
  message_id TEXT NOT NULL,
  opened_at  INTEGER NOT NULL,
  ua_hash    TEXT,
  ip_hash    TEXT,
  PRIMARY KEY (message_id, opened_at, ip_hash)
);
CREATE INDEX message_read_events_message ON message_read_events(message_id, opened_at DESC);

ALTER TABLE user_preferences ADD COLUMN default_track_opens INTEGER NOT NULL DEFAULT 0;
