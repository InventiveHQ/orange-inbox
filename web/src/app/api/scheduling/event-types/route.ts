import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  createEventType,
  listEventTypes,
  setEventTypeCalendars,
  slugExists,
} from "@/lib/booking";
import { validateEventTypeBody } from "@/lib/booking-input";

// GET  /api/scheduling/event-types        — list the caller's booking links
// POST /api/scheduling/event-types        — create one

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ eventTypes: await listEventTypes(user.id) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = await req.json().catch(() => null);
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    const v = validateEventTypeBody(b);
    if ("error" in v) {
      return NextResponse.json({ error: v.error }, { status: 400 });
    }
    if (await slugExists(v.input.slug)) {
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    }
    const eventType = await createEventType(user.id, v.input);
    if (v.calendars.length) {
      await setEventTypeCalendars(eventType.id, v.calendars);
    }
    return NextResponse.json({ eventType }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error("scheduling event-types route", e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
