-- Calendar event reminders (#85). Two tables:
--
--   calendar_event_reminders   — desired reminder offsets per event. Default
--                                of 10 minutes is seeded by application code
--                                in createSelfEvent (see web/src/lib/reminders.ts);
--                                the form will let the user edit/add chips
--                                in a follow-up slice.
--   calendar_reminders_sent    — dedupe ledger so the cron only fires each
--                                (event_id, minutes_before) reminder once,
--                                even if it lingers in the look-ahead window
--                                across multiple ticks.
--
-- Lives in control DB (calendar state is per-user and the calendar_events
-- table is here too).
--
-- Cron is the email-worker's existing 1-minute scheduled handler; it calls
-- /api/internal/dispatch-reminders on the web worker via the WEB service
-- binding. The web worker queries this table joined with calendar_events,
-- looks up push_subscriptions for the row's user_id, and sends Web Push.

PRAGMA foreign_keys = ON;

CREATE TABLE calendar_event_reminders (
  event_id       TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  minutes_before INTEGER NOT NULL,
  PRIMARY KEY (event_id, minutes_before)
);
CREATE INDEX calendar_event_reminders_event ON calendar_event_reminders(event_id);

-- Sent ledger. No FK to calendar_events: we want the row to survive even if
-- the user deletes the event, so re-creating an event with the same id (which
-- can't happen — id is a uuid — but defensive) doesn't accidentally re-fire.
-- Pruning happens lazily; rows are tiny.
CREATE TABLE calendar_reminders_sent (
  event_id       TEXT NOT NULL,
  minutes_before INTEGER NOT NULL,
  sent_at        INTEGER NOT NULL,
  PRIMARY KEY (event_id, minutes_before)
);
