import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getCalendarEvent } from "@/lib/calendar";
import { buildSingleEventCalendar } from "@/lib/ical";

// GET /api/calendar/events/<id>/ics
//
// Cookie-authenticated single-event download. OS-level "open with" pickers
// rely on the Content-Disposition `filename="…ics"` rather than the URL
// path, so the literal `.ics` extension at the URL level isn't needed —
// Next 16's type generator doesn't extract `[id]` from a combined
// `[id].ics` segment, hence the `[id]/ics/` split. The id portion is the
// calendar_events row id (NOT the ical_uid).
//
// Scoped to the caller's user_id via getCalendarEvent's WHERE clause — if
// the row exists but belongs to another user we return 404, identical to
// "not found" (don't leak existence).

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const row = await getCalendarEvent(user.id, id);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const host = await resolveHost();
    const body = buildSingleEventCalendar(row, {
      uidDomain: host,
      calendarName: row.summary ?? "Calendar event",
    });

    const filename = sanitiseFilename(row.summary ?? "event");
    return new Response(body, {
      status: 200,
      headers: {
        // RFC 5545 §3.6 — text/calendar; charset=UTF-8 with the optional
        // method parameter. PUBLISH matches what buildVCalendar emits.
        "Content-Type": "text/calendar; charset=utf-8; method=PUBLISH",
        "Content-Disposition": `attachment; filename="${filename}.ics"`,
        // Don't let intermediaries cache user-specific content.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("calendar event ics route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

async function resolveHost(): Promise<string> {
  try {
    const h = await headers();
    return h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  } catch {
    return "localhost";
  }
}

// Strip characters that would break Content-Disposition's quoted-string
// syntax. We keep this conservative — the filename is a hint to the OS,
// not a real path on the server.
function sanitiseFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n"\\/]/g, " ")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "event").slice(0, 80);
}
