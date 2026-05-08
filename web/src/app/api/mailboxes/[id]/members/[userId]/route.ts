import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isMailboxOwner } from "@/lib/mailbox-access";

const ROLES = ["owner", "member", "reader"] as const;
type Role = (typeof ROLES)[number];

interface PatchBody {
  role?: string;
}

// Change a member's role on a mailbox. Same access check as add/remove
// (only owners can manage). Demoting yourself when you're the last owner
// would orphan the mailbox; we reject that with the same 409 the DELETE
// handler uses for last-owner-removal.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId, userId: targetUserId } = await ctx.params;
    if (!(await isMailboxOwner(user.id, mailboxId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const b = (await req.json().catch(() => null)) as PatchBody | null;
    const role = b?.role;
    if (!role || !ROLES.includes(role as Role)) {
      return NextResponse.json(
        { error: `role required, one of ${ROLES.join("/")}` },
        { status: 400 },
      );
    }

    if (targetUserId === user.id && role !== "owner") {
      const otherOwners = await getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM user_mailbox_access
            WHERE mailbox_id = ? AND role = 'owner' AND user_id != ?`,
        )
        .bind(mailboxId, user.id)
        .first<{ n: number }>();
      if (!otherOwners || otherOwners.n === 0) {
        return NextResponse.json(
          { error: "cannot_demote_last_owner" },
          { status: 409 },
        );
      }
    }

    const res = await getDb()
      .prepare(
        "UPDATE user_mailbox_access SET role = ? WHERE mailbox_id = ? AND user_id = ?",
      )
      .bind(role, mailboxId, targetUserId)
      .run();
    if ((res.meta?.changes ?? 0) === 0) {
      return NextResponse.json({ error: "not_a_member" }, { status: 404 });
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
