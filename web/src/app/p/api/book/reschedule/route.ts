import { NextRequest, NextResponse } from "next/server";
import {
  getBookingByToken,
  getEventTypeById,
  getEventTypeCalendars,
  getOverrides,
  rescheduleBookingTime,
} from "@/lib/booking";
import { isSlotAvailable } from "@/lib/booking-availability";
import { rescheduleBookingFulfillment } from "@/lib/booking-fulfill";

// POST /p/api/book/reschedule  { token, start }
//
// Public — the reschedule token is the credential. Re-checks the new slot
// across every linked calendar, then moves every calendar event the booking
// touched and re-sends the invite.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => null)) as {
      token?: string;
      start?: number;
    } | null;
    const token = (b?.token ?? "").trim();
    if (!token) {
      return NextResponse.json({ error: "missing_token" }, { status: 400 });
    }
    if (typeof b?.start !== "number" || !Number.isFinite(b.start)) {
      return NextResponse.json({ error: "invalid_start" }, { status: 400 });
    }
    const booking = await getBookingByToken("reschedule", token);
    if (!booking) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (booking.status !== "confirmed") {
      return NextResponse.json(
        { error: "not_reschedulable", message: "This booking can't be rescheduled." },
        { status: 409 },
      );
    }
    const eventType = await getEventTypeById(booking.eventTypeId);
    if (!eventType) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const [calendars, overrides] = await Promise.all([
      getEventTypeCalendars(eventType.id),
      getOverrides(eventType.id),
    ]);
    if (!(await isSlotAvailable(eventType, calendars, overrides, b.start))) {
      return NextResponse.json(
        { error: "slot_unavailable", message: "That time isn't available." },
        { status: 409 },
      );
    }
    const newEnd = b.start + eventType.durationMinutes * 60;
    await rescheduleBookingFulfillment(eventType, booking, b.start, newEnd);
    await rescheduleBookingTime(booking.id, b.start, newEnd);
    return NextResponse.json({ ok: true, startsAt: b.start, endsAt: newEnd });
  } catch (e) {
    console.error("book reschedule route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
