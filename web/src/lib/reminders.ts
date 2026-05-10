import { getDb } from "./db";

// Calendar reminders (#85) — helpers for the dispatch path live here so we
// don't bloat web/src/lib/calendar.ts (owned by Agent A in parallel for the
// CalendarEventForm slice).
//
// Dispatch model: the email-worker cron ticks every minute and calls
// /api/internal/dispatch-reminders on the web worker. That endpoint walks
// calendar_event_reminders × calendar_events, filters to rows whose
// effective fire-time falls inside [now-60s, now+60s], skips rows already
// stamped in calendar_reminders_sent, sends a Web Push to every device of
// the event's owner, then writes the dedupe row.

// Default reminder offset (minutes) seeded into calendar_event_reminders
// when a self-authored event is created. The user can add/remove chips in
// the form (follow-up — Agent A owns CalendarEventForm).
export const DEFAULT_REMINDER_MINUTES_BEFORE = 10;

// Half the cron tick interval. The dispatcher selects rows whose fire time
// is within ±LOOKBACK_SECS of `now`, so we catch each reminder exactly once
// across a 1-minute cron schedule even with mild scheduling jitter.
export const LOOKBACK_SECS = 60;

// Seed the default 10-minute reminder for a freshly-created self event.
// Idempotent — the PK on (event_id, minutes_before) makes a duplicate insert
// a no-op. Kept here (not in calendar.ts) so Agent A can call it without
// taking a hard import dependency on this module from CalendarEventForm.
//
// TODO: invoke this from createSelfEvent in web/src/lib/calendar.ts (Agent A
// owns that file in parallel — leaving the wiring as follow-up).
export async function seedDefaultReminder(eventId: string): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO calendar_event_reminders (event_id, minutes_before)
         VALUES (?, ?)
       ON CONFLICT (event_id, minutes_before) DO NOTHING`,
    )
    .bind(eventId, DEFAULT_REMINDER_MINUTES_BEFORE)
    .run();
}

// Replace the set of reminders for an event. Used by the form's edit flow.
// Implemented here (not calendar.ts) so the form code can call it without
// pulling in calendar.ts internals — kept narrow on purpose.
export async function setRemindersForEvent(
  eventId: string,
  minutesBefore: number[],
): Promise<void> {
  const db = getDb();
  // De-dupe + filter out negatives / NaN / non-integers. Cap at a sane upper
  // bound (1 week) so a UI bug can't store a year-out reminder that lives in
  // the lookahead forever.
  const cleaned = Array.from(
    new Set(
      minutesBefore
        .map((n) => Math.floor(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 60 * 24 * 7),
    ),
  );
  await db
    .prepare("DELETE FROM calendar_event_reminders WHERE event_id = ?")
    .bind(eventId)
    .run();
  for (const m of cleaned) {
    await db
      .prepare(
        `INSERT INTO calendar_event_reminders (event_id, minutes_before)
           VALUES (?, ?)
         ON CONFLICT (event_id, minutes_before) DO NOTHING`,
      )
      .bind(eventId, m)
      .run();
  }
}

// Read reminders for one event, sorted ascending. Used by the form to render
// chips when editing an existing event.
export async function getRemindersForEvent(eventId: string): Promise<number[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT minutes_before FROM calendar_event_reminders
        WHERE event_id = ? ORDER BY minutes_before ASC`,
    )
    .bind(eventId)
    .all<{ minutes_before: number }>();
  return (results ?? []).map((r) => r.minutes_before);
}

// Row shape returned by the dispatch query — one per (event, reminder) due
// in the current window. We carry just enough event context to render the
// notification body without a second round-trip per row.
export interface DueReminderRow {
  event_id: string;
  minutes_before: number;
  user_id: string;
  starts_at: number;
  summary: string | null;
  location: string | null;
}

// Pull every reminder whose effective fire time (`starts_at - minutes_before*60`)
// lands inside [now - LOOKBACK_SECS, now + LOOKBACK_SECS], filtered to those
// that haven't been stamped in calendar_reminders_sent — OR have been
// snoozed and the snooze target has now elapsed (#96). Cancelled events are
// excluded; past events (whose reminder window has already elapsed) are not
// in the band by definition.
//
// Snooze interaction: rows in calendar_reminders_sent carry a nullable
// `snoozed_until` column. When the user taps "Snooze 5 min" on a reminder
// notification, the SW UPSERTs a row with sent_at = original fire time and
// snoozed_until = now+5*60. Two cases the WHERE clause has to handle:
//   1. Never sent — `s.sent_at IS NULL` (the original fire window).
//   2. Sent then snoozed — `snoozed_until` is non-null and now > snoozed_until,
//      and snoozed_until > sent_at (so we don't re-pick a row whose snooze
//      target has long since been satisfied by a prior re-fire).
// Once we fire the snoozed reminder we re-stamp `sent_at = now` and clear
// `snoozed_until`, so case (2) flips back to "fully delivered" — see
// markReminderSent below.
//
// The fire-time band check is also relaxed when snoozed: a snoozed row's
// effective fire time is `snoozed_until`, not `starts_at - minutes_before*60`.
//
// Capped at `limit` rows per tick — a backlog (e.g. cron paused for an hour
// then resumed) gets drained over multiple ticks rather than blowing the
// 30-second wall-clock budget on one minute.
export async function listDueReminders(
  nowSecs: number,
  limit = 200,
): Promise<DueReminderRow[]> {
  const lo = nowSecs - LOOKBACK_SECS;
  const hi = nowSecs + LOOKBACK_SECS;
  const { results } = await getDb()
    .prepare(
      `SELECT r.event_id        AS event_id,
              r.minutes_before  AS minutes_before,
              e.user_id         AS user_id,
              e.starts_at       AS starts_at,
              e.summary         AS summary,
              e.location        AS location
         FROM calendar_event_reminders r
         INNER JOIN calendar_events e ON e.id = r.event_id
         LEFT JOIN calendar_reminders_sent s
                ON s.event_id = r.event_id
               AND s.minutes_before = r.minutes_before
        WHERE e.cancelled = 0
          AND (
                -- Original fire path: never sent, and we're inside the band
                (s.sent_at IS NULL
                  AND (e.starts_at - r.minutes_before * 60) BETWEEN ? AND ?)
             OR -- Snoozed re-fire: snooze target has elapsed and is fresher
                -- than the last send. Use a half-open lookahead window so
                -- we catch the first tick after snoozed_until without also
                -- firing on every subsequent tick (sent_at gets bumped
                -- forward when we re-fire, see markReminderSent).
                (s.snoozed_until IS NOT NULL
                  AND s.snoozed_until > s.sent_at
                  AND s.snoozed_until BETWEEN ? AND ?)
              )
        ORDER BY (e.starts_at - r.minutes_before * 60) ASC
        LIMIT ?`,
    )
    .bind(lo, hi, lo, hi, limit)
    .all<DueReminderRow>();
  return results ?? [];
}

// Stamp a reminder as sent. The PK on (event_id, minutes_before) makes the
// INSERT itself the dedupe — a concurrent duplicate dispatch (cron retry
// after a partial failure) collides instead of double-firing.
//
// Snooze interaction (#96): on a re-fire after a snooze the row already
// exists (the snooze UPSERT created it). We therefore need DO UPDATE — bump
// sent_at to now AND clear snoozed_until, so listDueReminders' second arm
// stops matching. Otherwise the row would re-fire on every cron tick from
// here to the heat death of the universe.
export async function markReminderSent(
  eventId: string,
  minutesBefore: number,
  nowSecs: number,
): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO calendar_reminders_sent (event_id, minutes_before, sent_at, snoozed_until)
         VALUES (?, ?, ?, NULL)
       ON CONFLICT (event_id, minutes_before)
         DO UPDATE SET sent_at = excluded.sent_at, snoozed_until = NULL
         WHERE calendar_reminders_sent.snoozed_until IS NOT NULL`,
    )
    .bind(eventId, minutesBefore, nowSecs)
    .run();
}

// Snooze an already-fired reminder for `snoozeForMinutes` minutes (#96).
// Idempotent — repeated taps within the same window land on the same
// snoozed_until (we always recompute relative to `nowSecs`, but the second
// call just bumps the target forward, which is the obvious thing if a user
// taps "snooze" twice in quick succession).
//
// Does NOT verify ownership — the route handler is responsible for that
// (it has the user_id from the session). Keeping that check at the edge
// keeps this helper reusable from a future cron-side path that wants to
// auto-snooze (e.g. "snooze if device is asleep").
//
// We tolerate the row not existing yet — if a user taps snooze on a
// notification that arrived before we'd written the dedupe row (essentially
// impossible given dispatchForUser writes immediately, but defensive), we
// INSERT with sent_at = nowSecs to anchor sent_at < snoozed_until.
export async function snoozeReminder(
  eventId: string,
  minutesBefore: number,
  snoozeForMinutes: number,
  nowSecs: number,
): Promise<void> {
  const snoozedUntil = nowSecs + snoozeForMinutes * 60;
  await getDb()
    .prepare(
      `INSERT INTO calendar_reminders_sent (event_id, minutes_before, sent_at, snoozed_until)
         VALUES (?, ?, ?, ?)
       ON CONFLICT (event_id, minutes_before) DO UPDATE
         SET snoozed_until = excluded.snoozed_until`,
    )
    .bind(eventId, minutesBefore, nowSecs, snoozedUntil)
    .run();
}

// Push subscription rows for one user. Mirrors the inline shape used by
// notify-new-message — kept local rather than imported so this module
// doesn't take a dep on push-subscriptions.ts (which is mailbox-scoped).
export interface UserPushSub {
  endpoint: string;
  p256dh: string;
  auth_secret: string;
}

export async function listSubscriptionsForUser(
  userId: string,
): Promise<UserPushSub[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT endpoint, p256dh, auth_secret
         FROM push_subscriptions
        WHERE user_id = ?`,
    )
    .bind(userId)
    .all<UserPushSub>();
  return results ?? [];
}

// Build the payload for a single reminder. Single-event form ("Standup
// starts in 10 minutes"). The aggregator below produces a different body
// when multiple reminders for the same user land in the same tick.
//
// `minutesBefore` is included so the service worker can identify which
// (event_id, minutes_before) row to snooze when the user taps the Snooze
// action on the OS notification (#96).
export function singleReminderPayload(row: DueReminderRow) {
  const summary = row.summary?.trim() || "Untitled event";
  const minutesText = humanMinutes(row.minutes_before);
  const body = row.location?.trim()
    ? `${minutesText} · ${row.location.trim()}`
    : minutesText;
  return {
    title: `${summary} starts in ${humanRelative(row.minutes_before)}`,
    body,
    url: `/inbox/calendar?event=${encodeURIComponent(row.event_id)}`,
    eventId: row.event_id,
    minutesBefore: row.minutes_before,
    reminder: true,
  };
}

// Aggregate payload — fires when 2+ reminders for the same user are due in
// the same tick. Mirrors the issue's "3 events in the next hour" sketch.
export function aggregateReminderPayload(rows: DueReminderRow[]) {
  // Dedupe by event_id so two reminders for the same event (e.g. 30-min and
  // 10-min both happening to land in the same minute, which can happen when
  // cron skips a tick) count as one event.
  const events = Array.from(new Set(rows.map((r) => r.event_id)));
  const titles = rows
    .map((r) => r.summary?.trim() || "Untitled")
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 3);
  const more = events.length - titles.length;
  const titleSummary = more > 0
    ? `${titles.join(", ")} +${more} more`
    : titles.join(", ");
  return {
    title: `${events.length} events starting soon`,
    body: titleSummary,
    url: `/inbox/calendar`,
    aggregate: true,
    eventIds: events,
  };
}

function humanMinutes(m: number): string {
  if (m === 0) return "Starting now";
  if (m === 1) return "In 1 minute";
  if (m < 60) return `In ${m} minutes`;
  const hours = Math.round(m / 60);
  if (hours === 1) return "In 1 hour";
  return `In ${hours} hours`;
}

function humanRelative(m: number): string {
  if (m === 0) return "now";
  if (m === 1) return "1 minute";
  if (m < 60) return `${m} minutes`;
  const hours = Math.round(m / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
