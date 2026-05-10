import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  PERSONAL_CALENDAR,
  deleteSelfEvent,
  getCalendarEvent,
  updateSelfEvent,
  userHasMailboxAccess,
} from "@/lib/calendar";

// PATCH and DELETE for the per-user calendar_events row. Invites (rows where
// source != 'self') are read-only — the user's response goes through the
// RSVP-via-reply path on the message instead. Returning 403 keeps the
// boundary explicit on the wire.

interface PatchBody {
  summary?: string | null;
  starts_at?: number;
  ends_at?: number | null;
  all_day?: boolean;
  location?: string | null;
  description?: string | null;
  // Move between calendars (#78). null or "personal" → Personal; any
  // other value is a mailbox id and is access-checked.
  mailbox_id?: string | null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const row = await getCalendarEvent(user.id, id);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.source !== "self") {
      return NextResponse.json(
        {
          error: "read_only",
          message:
            "Invites are read-only; respond via the message's RSVP buttons.",
        },
        { status: 403 },
      );
    }
    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    // Validate the relative ordering of starts_at + ends_at. We accept a
    // partial patch, so synthesise "next" values from the existing row when
    // a field isn't being touched.
    const nextStarts =
      typeof b.starts_at === "number" ? b.starts_at : row.starts_at;
    const nextEnds =
      b.ends_at === undefined ? row.ends_at : b.ends_at;
    if (
      typeof nextStarts !== "number" ||
      !Number.isFinite(nextStarts)
    ) {
      return NextResponse.json({ error: "invalid_starts_at" }, { status: 400 });
    }
    if (
      nextEnds !== null &&
      (typeof nextEnds !== "number" ||
        !Number.isFinite(nextEnds) ||
        nextEnds <= nextStarts)
    ) {
      return NextResponse.json(
        { error: "invalid_range", message: "ends_at must be after starts_at" },
        { status: 400 },
      );
    }

    // Resolve the (optional) mailbox move. Distinguish "field absent" from
    // "field present with null/personal" — only the latter actually writes
    // mailbox_id back to the row.
    let nextMailboxId: string | null | undefined;
    if (Object.prototype.hasOwnProperty.call(b, "mailbox_id")) {
      const raw = b.mailbox_id;
      const resolved =
        typeof raw === "string" && raw && raw !== PERSONAL_CALENDAR ? raw : null;
      if (resolved && !(await userHasMailboxAccess(user.id, resolved))) {
        return NextResponse.json(
          { error: "forbidden_mailbox", message: "no access to that mailbox" },
          { status: 403 },
        );
      }
      nextMailboxId = resolved;
    }

    const ok = await updateSelfEvent(user.id, id, {
      mailboxId: nextMailboxId,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      allDay: b.all_day,
      summary:
        b.summary === undefined
          ? undefined
          : typeof b.summary === "string"
            ? b.summary.trim() || null
            : null,
      location:
        b.location === undefined
          ? undefined
          : typeof b.location === "string"
            ? b.location.trim() || null
            : null,
      description:
        b.description === undefined
          ? undefined
          : typeof b.description === "string"
            ? b.description.trim() || null
            : null,
    });
    if (!ok) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const row = await getCalendarEvent(user.id, id);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.source !== "self") {
      return NextResponse.json(
        {
          error: "read_only",
          message:
            "Invites can't be deleted from the calendar. Decline the RSVP instead.",
        },
        { status: 403 },
      );
    }
    const ok = await deleteSelfEvent(user.id, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error("calendar event id route", e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
