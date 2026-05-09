import { NextRequest, NextResponse } from "next/server";
import { ForbiddenError, UnauthenticatedError, requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";

const ROLES = ["owner", "member", "reader"] as const;
type Role = (typeof ROLES)[number];

interface PatchBody {
  role?: string;
}

// Refuse to leave the mailbox with zero owners. The 'owner' role inside the
// access table is informational under the global-admin model, but we keep
// at-least-one-owner as a soft data invariant (and as a hint to admins that
// they should delete the mailbox outright if they want it gone).
async function isLastOwner(mailboxId: string, targetUserId: string): Promise<boolean> {
  const target = await getDb()
    .prepare(
      "SELECT role FROM user_mailbox_access WHERE mailbox_id = ? AND user_id = ?",
    )
    .bind(mailboxId, targetUserId)
    .first<{ role: string }>();
  if (target?.role !== "owner") return false;
  const others = await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM user_mailbox_access
        WHERE mailbox_id = ? AND role = 'owner' AND user_id != ?`,
    )
    .bind(mailboxId, targetUserId)
    .first<{ n: number }>();
  return !others || others.n === 0;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    await requireAdmin();
    const { id: mailboxId, userId: targetUserId } = await ctx.params;

    const b = (await req.json().catch(() => null)) as PatchBody | null;
    const role = b?.role;
    if (!role || !ROLES.includes(role as Role)) {
      return NextResponse.json(
        { error: `role required, one of ${ROLES.join("/")}` },
        { status: 400 },
      );
    }

    if (role !== "owner" && (await isLastOwner(mailboxId, targetUserId))) {
      return NextResponse.json(
        { error: "cannot_demote_last_owner" },
        { status: 409 },
      );
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
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    await requireAdmin();
    const { id: mailboxId, userId: targetUserId } = await ctx.params;

    if (await isLastOwner(mailboxId, targetUserId)) {
      return NextResponse.json(
        { error: "cannot_remove_last_owner" },
        { status: 409 },
      );
    }

    await getDb()
      .prepare("DELETE FROM user_mailbox_access WHERE mailbox_id = ? AND user_id = ?")
      .bind(mailboxId, targetUserId)
      .run();

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
