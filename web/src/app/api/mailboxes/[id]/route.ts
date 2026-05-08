import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDomainAdmin, isMailboxOwner } from "@/lib/mailbox-access";

// Owner of the mailbox or admin of its parent domain may delete it.
// ON DELETE CASCADE on threads/messages/attachments/access rows handles
// the rest.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;

    const mb = await getDb()
      .prepare("SELECT id, domain_id FROM mailboxes WHERE id = ?")
      .bind(mailboxId)
      .first<{ id: string; domain_id: string }>();
    if (!mb) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const allowed =
      (await isMailboxOwner(user.id, mailboxId)) ||
      (await isDomainAdmin(user.id, mb.domain_id));
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    await getDb().prepare("DELETE FROM mailboxes WHERE id = ?").bind(mailboxId).run();
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
