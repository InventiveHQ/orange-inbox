import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { deleteCalendarConnection } from "@/lib/booking";

// DELETE /api/scheduling/connections/<id> — disconnect a Google calendar.

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const ok = await deleteCalendarConnection(user.id, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("scheduling connection delete route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
