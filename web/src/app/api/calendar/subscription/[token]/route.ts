import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { revokeToken } from "@/lib/ics-tokens";

// DELETE /api/calendar/subscription/<token>
//
// Revoke a single ICS subscription token. Scoped to the caller — `revokeToken`
// matches on (token, user_id) so a user can't revoke another user's token
// even if they somehow learned the token string.

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  try {
    const user = await requireUser();
    const { token } = await ctx.params;
    if (!token) {
      return NextResponse.json({ error: "missing_token" }, { status: 400 });
    }
    const ok = await revokeToken(user.id, token);
    if (!ok) {
      // Either the token doesn't exist, belongs to another user, or was
      // already revoked. Same response either way — don't leak existence.
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("ics tokens DELETE", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
