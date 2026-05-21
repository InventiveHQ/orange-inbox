import { NextRequest, NextResponse } from "next/server";
import {
  cancelBooking,
  getBookingByToken,
  getEventTypeById,
} from "@/lib/booking";
import { cancelBookingFulfillment } from "@/lib/booking-fulfill";

// POST /p/api/book/cancel  { token, reason? }
//
// Public — the cancel token is the credential. Fans the cancellation out to
// every calendar the booking touched and emails a CANCEL .ics.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => null)) as {
      token?: string;
      reason?: string;
    } | null;
    const token = (b?.token ?? "").trim();
    if (!token) {
      return NextResponse.json({ error: "missing_token" }, { status: 400 });
    }
    const booking = await getBookingByToken("cancel", token);
    if (!booking) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (booking.status === "cancelled") {
      return NextResponse.json({ ok: true, already: true });
    }
    const eventType = await getEventTypeById(booking.eventTypeId);
    await cancelBooking(
      booking.id,
      typeof b?.reason === "string" ? b.reason.slice(0, 500) : null,
    );
    if (eventType) {
      await cancelBookingFulfillment(eventType, booking);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("book cancel route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
