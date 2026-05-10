import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  PERSONAL_CALENDAR,
  type CalendarFilter,
  createSelfEvent,
  listCalendarEvents,
  searchCalendarEvents,
  userHasMailboxAccess,
  type CalendarEventRow,
} from "@/lib/calendar";

// GET /api/calendar/events?from=<unix>&to=<unix>[&mailbox=<id|personal>]
//   Returns the caller's calendar rows that overlap [from, to). Both bounds
//   are required: the grid views always query a bounded window, and an open
//   range could in theory scan an entire user's history.
//   `mailbox` filters to a single calendar:
//     - "personal" → mailbox_id IS NULL only
//     - any string → that mailbox's calendar (if user has access; mismatch
//                    falls through to an empty result)
//     - omitted    → consolidated view (every accessible calendar except
//                    those marked hidden in user_calendar_prefs)
//
// POST /api/calendar/events
//   Creates a self-authored event. Optional `mailbox_id` in the body picks
//   the target calendar (#78); absence = Personal. Invites are never
//   created via this route — those land via the email-worker →
//   message_calendar_events → lazy promotion path in promoteInvitesForThread.

// Cap the window to a year on either side of `from`. Defensive: a 10-year
// range would still be fine for a typical user (calendar_events_user_starts
// index makes it index-bounded), but capping keeps a hostile client from
// asking for the full table.
const MAX_RANGE_SECONDS = 366 * 24 * 60 * 60 * 2;

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();

    // Mailbox filter: "personal" maps onto the NULL-mailbox path; any
    // other value is treated as a mailbox id. We don't 403 on mismatch —
    // listCalendarEvents will simply return the empty set, which matches
    // the "no rows" UX of an unhidden mailbox the user happens to have
    // never received an invite to. Saves an extra round trip here.
    const mailboxParam = url.searchParams.get("mailbox");
    const filter: CalendarFilter | undefined =
      mailboxParam == null
        ? undefined
        : mailboxParam === PERSONAL_CALENDAR
          ? PERSONAL_CALENDAR
          : mailboxParam;

    // Server-side search path (#84). When ?q= is set, the from/to window
    // is *optional* — search runs across the user's full history, capped
    // and ordered by recency (most recent first). If from/to are also
    // supplied we still respect them so a caller can scope a search to
    // "this year" if they want.
    if (q) {
      const fromRaw = url.searchParams.get("from");
      const toRaw = url.searchParams.get("to");
      let from: number | undefined;
      let to: number | undefined;
      if (fromRaw && toRaw) {
        from = Number(fromRaw);
        to = Number(toRaw);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
          return NextResponse.json({ error: "invalid_range" }, { status: 400 });
        }
        if (to - from > MAX_RANGE_SECONDS) {
          return NextResponse.json(
            { error: "range_too_wide", message: "window must be <= ~2 years" },
            { status: 400 },
          );
        }
      }
      const events = await searchCalendarEvents(user.id, q, {
        from,
        to,
        filter,
        limit: 100,
      });
      return NextResponse.json({ events });
    }

    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");
    if (!fromRaw || !toRaw) {
      return NextResponse.json(
        { error: "missing_range", message: "from and to (unix seconds) are required" },
        { status: 400 },
      );
    }
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return NextResponse.json({ error: "invalid_range" }, { status: 400 });
    }
    if (to - from > MAX_RANGE_SECONDS) {
      return NextResponse.json(
        { error: "range_too_wide", message: "window must be <= ~2 years" },
        { status: 400 },
      );
    }

    const events = await listCalendarEvents(user.id, from, to, filter);
    return NextResponse.json({ events });
  } catch (e) {
    return errorResponse(e);
  }
}

interface CreateBody {
  summary?: string;
  starts_at?: number;
  ends_at?: number | null;
  all_day?: boolean;
  location?: string | null;
  description?: string | null;
  // null / undefined / "personal" all map to the Personal calendar.
  mailbox_id?: string | null;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as CreateBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const summary = typeof b.summary === "string" ? b.summary.trim() : "";
    if (!summary) {
      return NextResponse.json(
        { error: "missing_summary", message: "summary is required" },
        { status: 400 },
      );
    }
    if (typeof b.starts_at !== "number" || !Number.isFinite(b.starts_at)) {
      return NextResponse.json(
        { error: "invalid_starts_at" },
        { status: 400 },
      );
    }
    const endsAt =
      b.ends_at == null
        ? null
        : typeof b.ends_at === "number" && Number.isFinite(b.ends_at)
          ? b.ends_at
          : NaN;
    if (Number.isNaN(endsAt)) {
      return NextResponse.json({ error: "invalid_ends_at" }, { status: 400 });
    }
    if (endsAt !== null && endsAt <= b.starts_at) {
      return NextResponse.json(
        { error: "invalid_range", message: "ends_at must be after starts_at" },
        { status: 400 },
      );
    }

    // Resolve the target calendar. NULL / "personal" / "" → Personal;
    // anything else is a mailbox id and we enforce access before storing.
    const requestedMailbox =
      typeof b.mailbox_id === "string" && b.mailbox_id && b.mailbox_id !== PERSONAL_CALENDAR
        ? b.mailbox_id
        : null;
    if (requestedMailbox && !(await userHasMailboxAccess(user.id, requestedMailbox))) {
      return NextResponse.json(
        { error: "forbidden_mailbox", message: "no access to that mailbox" },
        { status: 403 },
      );
    }

    const id = await createSelfEvent({
      userId: user.id,
      mailboxId: requestedMailbox,
      startsAt: b.starts_at,
      endsAt,
      allDay: !!b.all_day,
      summary,
      location:
        typeof b.location === "string" ? b.location.trim() || null : null,
      description:
        typeof b.description === "string" ? b.description.trim() || null : null,
    });
    // Hand back a row-shaped object so the client can optimistically render
    // without a follow-up GET.
    const event: Partial<CalendarEventRow> = {
      id,
      user_id: user.id,
      mailbox_id: requestedMailbox,
      source: "self",
      ical_uid: null,
      source_message_id: null,
      starts_at: b.starts_at,
      ends_at: endsAt,
      all_day: b.all_day ? 1 : 0,
      summary,
      location: b.location?.toString().trim() || null,
      description: b.description?.toString().trim() || null,
      organizer_email: null,
      rsvp_status: null,
      rsvp_sent_at: null,
      cancelled: 0,
      raw_ics: null,
    };
    return NextResponse.json({ event }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error("calendar events route", e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
