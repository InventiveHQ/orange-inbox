import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { listBookingsForUser } from "@/lib/booking";

// GET /api/scheduling/bookings[?upcoming=1]  — the caller's bookings.

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const upcoming =
      new URL(req.url).searchParams.get("upcoming") === "1";
    const bookings = await listBookingsForUser(user.id, { upcoming });
    return NextResponse.json({ bookings });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("scheduling bookings route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
