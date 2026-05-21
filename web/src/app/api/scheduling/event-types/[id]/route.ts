import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  deleteEventType,
  getEventType,
  getEventTypeCalendars,
  setEventTypeCalendars,
  slugExists,
  updateEventType,
} from "@/lib/booking";
import { validateEventTypeBody } from "@/lib/booking-input";

// GET    /api/scheduling/event-types/<id>  — one booking link + its calendars
// PATCH  /api/scheduling/event-types/<id>  — full replace (editor submits all)
// DELETE /api/scheduling/event-types/<id>

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const eventType = await getEventType(user.id, id);
    if (!eventType) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const calendars = await getEventTypeCalendars(id);
    return NextResponse.json({ eventType, calendars });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const existing = await getEventType(user.id, id);
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const b = await req.json().catch(() => null);
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    const v = validateEventTypeBody(b);
    if ("error" in v) {
      return NextResponse.json({ error: v.error }, { status: 400 });
    }
    if (await slugExists(v.input.slug, id)) {
      return NextResponse.json({ error: "slug_taken" }, { status: 409 });
    }
    const eventType = await updateEventType(user.id, id, v.input);
    await setEventTypeCalendars(id, v.calendars);
    return NextResponse.json({ eventType });
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
    const ok = await deleteEventType(user.id, id);
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
  console.error("scheduling event-type id route", e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
