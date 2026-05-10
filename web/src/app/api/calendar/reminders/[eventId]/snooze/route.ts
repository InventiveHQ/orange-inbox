import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getCalendarEvent } from "@/lib/calendar";
import { snoozeReminder } from "@/lib/reminders";

// Snooze a calendar reminder (#96). Hit by the service worker when the user
// taps the "Snooze 5 min" action on a reminder push notification — the SW
// reads `eventId` and `minutesBefore` out of the push payload it received
// (see web/src/lib/reminders.ts: singleReminderPayload) and POSTs here.
//
// Auth: same-origin user cookie via requireUser. The SW is registered at
// the same origin as the rest of the PWA, so the fetch carries the session
// cookie. Ownership is enforced by re-loading the event scoped to the
// current user — getCalendarEvent's WHERE clause includes user_id, so a
// different user's event id resolves to null and we 404 (matches the
// "don't leak existence" pattern used elsewhere in the calendar API).
//
// Idempotent: snoozeReminder UPSERTs into calendar_reminders_sent with
// `snoozed_until = now + snooze_for_minutes * 60`. A second tap within the
// same window simply bumps the snooze target forward — that's the obvious
// behaviour for a user who hits the button twice.

interface Body {
  // The reminder offset to snooze. Multiple reminders can be configured
  // per event (10-min, 1-hour, etc.); we have to know which one fired so
  // the dedupe key matches what listDueReminders looks up.
  minutes_before?: number;
  // How many minutes from now to snooze for. Defaults to 5 (matches the
  // OS action label "Snooze 5 min"). Capped to 24h to avoid a UI bug
  // sending us a year-out target.
  snooze_for_minutes?: number;
}

const DEFAULT_SNOOZE_MINUTES = 5;
const MAX_SNOOZE_MINUTES = 60 * 24;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ eventId: string }> },
) {
  try {
    const user = await requireUser();
    const { eventId } = await ctx.params;
    if (!eventId) {
      return NextResponse.json({ error: "event_id_required" }, { status: 400 });
    }

    const b = (await req.json().catch(() => null)) as Body | null;
    const minutesBeforeRaw = b?.minutes_before;
    if (
      typeof minutesBeforeRaw !== "number" ||
      !Number.isFinite(minutesBeforeRaw) ||
      minutesBeforeRaw < 0
    ) {
      return NextResponse.json(
        { error: "invalid_minutes_before" },
        { status: 400 },
      );
    }
    const minutesBefore = Math.floor(minutesBeforeRaw);

    const snoozeForRaw = b?.snooze_for_minutes;
    let snoozeFor = DEFAULT_SNOOZE_MINUTES;
    if (snoozeForRaw !== undefined) {
      if (
        typeof snoozeForRaw !== "number" ||
        !Number.isFinite(snoozeForRaw) ||
        snoozeForRaw <= 0 ||
        snoozeForRaw > MAX_SNOOZE_MINUTES
      ) {
        return NextResponse.json(
          { error: "invalid_snooze_for_minutes" },
          { status: 400 },
        );
      }
      snoozeFor = Math.floor(snoozeForRaw);
    }

    // Ownership check. getCalendarEvent scopes to user_id — a row owned by
    // someone else (or a deleted event) returns null and we 404. We don't
    // distinguish "no such event" from "not yours" on the wire.
    const row = await getCalendarEvent(user.id, eventId);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    await snoozeReminder(eventId, minutesBefore, snoozeFor, nowSecs);
    return NextResponse.json({
      ok: true,
      snoozed_until: nowSecs + snoozeFor * 60,
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("calendar reminder snooze route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
