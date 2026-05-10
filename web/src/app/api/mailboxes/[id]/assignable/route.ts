import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listMailboxMembers } from "@/lib/mailbox-access";

// Members of a mailbox the current user can also see (i.e. assignable
// candidates for the "Assign to…" menu in ThreadActions). Different from the
// admin-only /api/mailboxes/<id>/members endpoint: this one is open to any
// mailbox member so they can pick a teammate from the dropdown without needing
// admin rights.
//
// Returns only the fields the picker needs (id, email, display_name); roles
// and timestamps are filtered out so we don't leak more than necessary.

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;

    // Membership gate: only members of the mailbox can see the list. Without
    // this an arbitrary signed-in user could enumerate "who's on the
    // support@ mailbox".
    const access = await getDb()
      .prepare(
        `SELECT 1 FROM user_mailbox_access
          WHERE mailbox_id = ? AND user_id = ?
          LIMIT 1`,
      )
      .bind(mailboxId, user.id)
      .first();
    if (!access) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const members = await listMailboxMembers(mailboxId);
    return NextResponse.json({
      members: members.map(m => ({
        user_id: m.user_id,
        email: m.email,
        display_name: m.display_name,
      })),
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
