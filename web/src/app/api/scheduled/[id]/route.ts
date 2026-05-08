import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// Cancel a pending scheduled send. We mark cancelled (rather than deleting)
// so the user's history of "you scheduled X but cancelled" is queryable
// later if we add that view.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const res = await getDb()
      .prepare(
        `UPDATE scheduled_messages
            SET status = 'cancelled'
          WHERE id = ? AND user_id = ? AND status = 'pending'`,
      )
      .bind(id, user.id)
      .run();
    if (!res.meta.changes) {
      return NextResponse.json({ error: "not_found_or_already_finalised" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
