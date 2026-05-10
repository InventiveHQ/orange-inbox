import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { splitRecurrenceAt } from "@/lib/calendar";

// POST /api/calendar/events/<id>/split
//
// "Edit this and following" path for recurring events (#92). The form
// posts here with the instance the user is splitting at + the patch to
// apply to the new series:
//
//   {
//     "occurrence_starts_at": <unix seconds>,
//     "patch": { summary?, location?, description?, starts_at?, ends_at?,
//                all_day?, tz? }
//   }
//
// Returns the new event's id on success. The original master event keeps
// its id (the API caller is the form, and refreshing the grid will pick
// up the new row); we never delete the master because instances BEFORE
// the split point still belong to it.
//
// Authorisation lives inside splitRecurrenceAt (parent must be owned by
// the caller AND source='self'). A non-recurring event or a wrong owner
// returns 404 to avoid leaking row existence.

interface SplitBody {
  occurrence_starts_at?: number;
  patch?: {
    summary?: string | null;
    starts_at?: number;
    ends_at?: number | null;
    all_day?: boolean;
    location?: string | null;
    description?: string | null;
    tz?: string | null;
  };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as SplitBody | null;
    if (!body) {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const occ = body.occurrence_starts_at;
    if (typeof occ !== "number" || !Number.isFinite(occ)) {
      return NextResponse.json(
        { error: "invalid_occurrence_starts_at" },
        { status: 400 },
      );
    }
    const p = body.patch ?? {};
    // Validate the relative ordering of starts_at + ends_at when both are
    // touched in the patch. Either-only is fine — splitRecurrenceAt
    // overlays on the master's values.
    if (
      typeof p.starts_at === "number" &&
      typeof p.ends_at === "number" &&
      p.ends_at <= p.starts_at
    ) {
      return NextResponse.json(
        { error: "invalid_range", message: "ends_at must be after starts_at" },
        { status: 400 },
      );
    }

    const newId = await splitRecurrenceAt(user.id, id, occ, {
      startsAt: typeof p.starts_at === "number" ? p.starts_at : undefined,
      endsAt:
        p.ends_at === undefined
          ? undefined
          : typeof p.ends_at === "number"
            ? p.ends_at
            : null,
      allDay: typeof p.all_day === "boolean" ? p.all_day : undefined,
      summary:
        p.summary === undefined
          ? undefined
          : typeof p.summary === "string"
            ? p.summary.trim() || null
            : null,
      location:
        p.location === undefined
          ? undefined
          : typeof p.location === "string"
            ? p.location.trim() || null
            : null,
      description:
        p.description === undefined
          ? undefined
          : typeof p.description === "string"
            ? p.description.trim() || null
            : null,
      tz:
        p.tz === undefined
          ? undefined
          : typeof p.tz === "string"
            ? p.tz.trim() || null
            : null,
    });
    if (!newId) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, event_id: newId }, { status: 201 });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("calendar split route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
