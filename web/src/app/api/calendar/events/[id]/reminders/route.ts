import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getCalendarEvent } from "@/lib/calendar";
import { getRemindersForEvent, setRemindersForEvent } from "@/lib/reminders";

// CRUD for an event's reminder offsets (#91). The CalendarEventForm
// Reminders chips wire against this:
//
//   GET → list of `minutes_before` integers (sorted ascending) so the
//         form can render existing chips on edit-mode mount.
//   PUT → replace the entire reminder set wholesale. Mirrors the
//         attendees route's PUT semantics (see [id]/attendees/route.ts):
//         the form submits the canonical state, the route DELETE+INSERTs
//         to match. Idempotent on (event_id, minutes_before) by virtue
//         of the table's PK.
//
// Why a sub-route rather than folding into [id]/route.ts: reminders are
// per-event metadata that doesn't fit cleanly into the row PATCH shape,
// and keeping it separate avoids a single 30-field JSON body during
// save. Same pattern as attendees.
//
// Auth: parent event must belong to the caller AND be source='self' —
// invites are read-only (the form's reminders section is hidden in
// invite mode anyway, but the route belt-and-braces here).

interface PutBody {
  minutes_before?: unknown;
}

// Cap on the number of distinct reminders per event (#91 spec). Five is
// generous — Google Calendar caps at 5 too — and keeps the notification
// fan-out predictable (5 reminders × N devices is the worst case).
const MAX_REMINDERS = 5;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const row = await getCalendarEvent(user.id, id);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.source !== "self") {
      return NextResponse.json({ error: "read_only" }, { status: 403 });
    }
    const minutes = await getRemindersForEvent(id);
    return NextResponse.json({ minutes_before: minutes });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const row = await getCalendarEvent(user.id, id);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.source !== "self") {
      return NextResponse.json({ error: "read_only" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as PutBody | null;
    if (!body) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    const raw = body.minutes_before;
    if (!Array.isArray(raw)) {
      return NextResponse.json(
        { error: "invalid_minutes_before" },
        { status: 400 },
      );
    }
    // Coerce + clamp at MAX_REMINDERS to match the form's UI cap; a stray
    // extra entry past the cap gets silently dropped (vs a 400) so the
    // optimistic save doesn't fail when a user adds a 6th chip in a
    // race with the cap check on the client side.
    const cleaned = Array.from(
      new Set(
        raw
          .map((n) => Math.floor(Number(n)))
          .filter(
            (n) => Number.isFinite(n) && n >= 0 && n <= 60 * 24 * 7,
          ),
      ),
    ).slice(0, MAX_REMINDERS);

    await setRemindersForEvent(id, cleaned);
    return NextResponse.json({ ok: true, minutes_before: cleaned });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error("calendar reminders route", e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
