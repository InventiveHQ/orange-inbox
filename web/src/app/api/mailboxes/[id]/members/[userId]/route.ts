import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isMailboxOwner } from "@/lib/mailbox-access";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId, userId: targetUserId } = await ctx.params;
    if (!(await isMailboxOwner(user.id, mailboxId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Prevent the only owner from removing themselves and orphaning the
    // mailbox. Last-owner removal would leave the mailbox unmanaged.
    if (targetUserId === user.id) {
      const otherOwners = await getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM user_mailbox_access
            WHERE mailbox_id = ? AND role = 'owner' AND user_id != ?`,
        )
        .bind(mailboxId, user.id)
        .first<{ n: number }>();
      if (!otherOwners || otherOwners.n === 0) {
        return NextResponse.json(
          { error: "cannot_remove_last_owner" },
          { status: 409 },
        );
      }
    }

    await getDb()
      .prepare("DELETE FROM user_mailbox_access WHERE mailbox_id = ? AND user_id = ?")
      .bind(mailboxId, targetUserId)
      .run();

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
