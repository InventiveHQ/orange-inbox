import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { upsertEventOverride } from "@/lib/calendar";

// POST /api/calendar/events/<id>/overrides
//
// "Edit this only" path for recurring events (#92). Writes a single
// occurrence override into calendar_event_overrides — keyed by
// (parent_event_id, original_starts_at). Subsequent edits to the same
// instance UPSERT onto the same row.
//
// Body shape:
//   {
//     "original_starts_at": <unix seconds>,    // the seed time of the
//                                              //   instance being edited
//     "patch": {
//       "starts_at"?: <unix seconds>,
//       "ends_at"?: <unix seconds | null>,
//       "summary"?: string | null,
//       "cancelled"?: boolean
//     }
//   }
//
// Authorisation rides on upsertEventOverride's WHERE on
// (id, user_id, source='self'); a 404 covers "not yours" and
// "doesn't exist" identically.

interface OverrideBody {
  original_starts_at?: number;
  patch?: {
    starts_at?: number | null;
    ends_at?: number | null;
    summary?: string | null;
    cancelled?: boolean;
  };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as OverrideBody | null;
    if (!body) {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const orig = body.original_starts_at;
    if (typeof orig !== "number" || !Number.isFinite(orig)) {
      return NextResponse.json(
        { error: "invalid_original_starts_at" },
        { status: 400 },
      );
    }
    const p = body.patch ?? {};
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
    const ok = await upsertEventOverride(user.id, id, orig, {
      startsAt:
        p.starts_at === undefined
          ? undefined
          : typeof p.starts_at === "number"
            ? p.starts_at
            : null,
      endsAt:
        p.ends_at === undefined
          ? undefined
          : typeof p.ends_at === "number"
            ? p.ends_at
            : null,
      summary:
        p.summary === undefined
          ? undefined
          : typeof p.summary === "string"
            ? p.summary.trim() || null
            : null,
      cancelled: typeof p.cancelled === "boolean" ? p.cancelled : undefined,
    });
    if (!ok) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("calendar overrides route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
