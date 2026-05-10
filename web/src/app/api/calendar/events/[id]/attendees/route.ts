import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  getCalendarEvent,
  listAttendees,
  setAttendees,
  updateSelfEvent,
} from "@/lib/calendar";
import { buildRequestIcs } from "@/lib/ical-build";
import { sendCalendarInvite, SendError } from "@/lib/send";

// CRUD for an event's attendee list (#81). Wired up by CalendarEventForm:
//
//   GET  → return the current attendee rows so the form can render chips
//          on edit-mode load.
//   PUT  → replace the attendee list wholesale. Triggers a fresh
//          METHOD=REQUEST send to the new list. ical_uid is stamped on
//          the parent event if it was previously NULL (first time the
//          event acquires attendees → we need a stable correlation key).
//
// Why PUT not POST: the wire shape is "here's the full list" — a PATCH
// with deltas would fight with the form's "drop a chip → save" UX.
//
// We deliberately don't surface DELETE — clearing the attendee list is a
// PUT with body `{ attendees: [] }`, and that doesn't fire a CANCEL
// because there's nobody left to send to. (Removing individual
// attendees from a still-active event is also a PUT; v1 doesn't email
// the dropped attendees to inform them — Apple Calendar doesn't either,
// and it keeps the UX predictable.)

interface AttendeeBody {
  email?: string;
  role?: string | null;
}

interface PutBody {
  attendees?: AttendeeBody[];
  // Optional cosmetic — controls whether the API ALSO fires a fresh
  // REQUEST. Default true. Set false for "stash the list, don't notify"
  // flows (e.g. an admin import).
  send?: boolean;
}

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
    const attendees = await listAttendees(id);
    return NextResponse.json({ attendees });
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

    const incoming = (body.attendees ?? [])
      .map(a => ({
        email: typeof a.email === "string" ? a.email.trim() : "",
        role: typeof a.role === "string" ? a.role : null,
      }))
      .filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email));

    // Self events that gain attendees need a stable ical_uid for external
    // calendar dedupe (#81). Stamp one on first promotion. Existing UID
    // is preserved on subsequent edits — that's THE rule for round-trip
    // dedupe to work.
    let icalUid = row.ical_uid;
    if (incoming.length > 0 && icalUid == null) {
      icalUid = `${crypto.randomUUID()}@orange-inbox.local`;
      await updateSelfEvent(user.id, id, { icalUid });
    }

    await setAttendees(id, incoming);

    // Optionally fire a METHOD=REQUEST to the (new) full list. We always
    // re-send to everyone — that's how external calendars learn about
    // both adds and field updates (RFC 5546 expects a single REQUEST
    // covering the canonical state, not deltas).
    const shouldSend = body.send !== false;
    let sent = false;
    if (shouldSend && incoming.length > 0 && row.mailbox_id && icalUid) {
      try {
        const ics = buildRequestIcs({
          uid: icalUid,
          dtstamp: Math.floor(Date.now() / 1000),
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          allDay: row.all_day === 1,
          summary: row.summary,
          location: row.location,
          description: row.description,
          organizer: user.email,
          organizerName: user.display_name,
          attendees: incoming.map(a => ({ email: a.email, role: a.role })),
          // SEQUENCE bumps on every edit. updated_at - created_at is a
          // monotonic-enough proxy for "how many times has this been
          // edited"; +1 because the very first REQUEST should be 0 and
          // subsequent ones strictly greater.
          sequence: Math.max(0, row.updated_at - row.created_at),
          rrule: row.rrule,
          tz: row.tz,
        });
        await sendCalendarInvite(user.id, {
          fromMailboxId: row.mailbox_id,
          to: incoming.map(a => a.email),
          subject: `Invite: ${row.summary ?? "(no title)"}`,
          text: buildPlainTextDescription(row.summary, row.starts_at, row.location),
          ics,
          method: "REQUEST",
        });
        sent = true;
      } catch (e) {
        // Don't roll back the attendee write on a send failure: the user
        // can hit save again or send manually. Surface the error so the
        // form can render a banner.
        const msg = e instanceof SendError ? e.message : (e instanceof Error ? e.message : String(e));
        return NextResponse.json(
          { ok: true, sent: false, send_error: msg },
          { status: 207 },
        );
      }
    }

    return NextResponse.json({ ok: true, sent, ical_uid: icalUid });
  } catch (e) {
    return errorResponse(e);
  }
}

function buildPlainTextDescription(
  summary: string | null,
  startsAt: number,
  location: string | null,
): string {
  const when = new Date(startsAt * 1000).toUTCString();
  const lines = [
    `You are invited to "${summary ?? "(no title)"}".`,
    `When: ${when}`,
  ];
  if (location) lines.push(`Where: ${location}`);
  lines.push("");
  lines.push("(Open the attached calendar invite to RSVP.)");
  return lines.join("\n");
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error("calendar attendees route", e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
