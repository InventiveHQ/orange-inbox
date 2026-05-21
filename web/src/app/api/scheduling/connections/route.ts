import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { listCalendarConnections } from "@/lib/booking";

// GET /api/scheduling/connections — the caller's connected Google calendars
// (encrypted tokens are never returned).

export async function GET() {
  try {
    const user = await requireUser();
    const conns = await listCalendarConnections(user.id);
    return NextResponse.json({
      connections: conns.map((c) => ({
        id: c.id,
        accountEmail: c.accountEmail,
        displayName: c.displayName,
        calendarId: c.calendarId,
        status: c.status,
        lastError: c.lastError,
        createdAt: c.createdAt,
      })),
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("scheduling connections route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
