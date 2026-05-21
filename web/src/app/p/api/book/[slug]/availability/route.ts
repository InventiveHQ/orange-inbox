import { NextRequest, NextResponse } from "next/server";
import {
  getEventTypeBySlug,
  getEventTypeCalendars,
  getOverrides,
} from "@/lib/booking";
import { computeAvailableSlots } from "@/lib/booking-availability";

// GET /p/api/book/<slug>/availability?from=<unix>&to=<unix>
//
// Public — no authentication. Lives under /p/*, covered by the public
// Cloudflare Access Bypass policy. Returns the open slots for the booking
// link within the window, as the intersection across every linked calendar.

export const dynamic = "force-dynamic";

const MAX_RANGE_SECONDS = 62 * 24 * 60 * 60;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const eventType = await getEventTypeBySlug(slug);
    if (!eventType) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const url = new URL(req.url);
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return NextResponse.json({ error: "invalid_range" }, { status: 400 });
    }
    if (to - from > MAX_RANGE_SECONDS) {
      return NextResponse.json({ error: "range_too_wide" }, { status: 400 });
    }
    const [calendars, overrides] = await Promise.all([
      getEventTypeCalendars(eventType.id),
      getOverrides(eventType.id),
    ]);
    const slots = await computeAvailableSlots(
      eventType,
      calendars,
      overrides,
      from,
      to,
    );
    return NextResponse.json({
      slots,
      durationMinutes: eventType.durationMinutes,
      timezone: eventType.timezone,
    });
  } catch (e) {
    console.error("book availability route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
