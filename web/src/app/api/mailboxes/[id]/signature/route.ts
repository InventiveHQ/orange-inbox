import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

interface PatchBody {
  signature_html?: string | null;
}

// Hard cap so a runaway editor can't blow up the row.
const MAX_SIGNATURE_BYTES = 8 * 1024;

// Per-mailbox signature edits. Carved out from /api/mailboxes/[id] (which is
// admin-only for structural fields like local_part/is_catch_all) so any
// mailbox *owner* can update their own signature without elevated permission.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;

    const access = await getDb()
      .prepare(
        "SELECT role FROM user_mailbox_access WHERE user_id = ? AND mailbox_id = ?",
      )
      .bind(user.id, mailboxId)
      .first<{ role: "owner" | "member" | "reader" }>();
    if (!access || access.role !== "owner") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b || b.signature_html === undefined) {
      return NextResponse.json({ error: "signature_html required" }, { status: 400 });
    }

    const sig = b.signature_html == null ? null : String(b.signature_html);
    if (sig != null && sig.length > MAX_SIGNATURE_BYTES) {
      return NextResponse.json({ error: "signature too long" }, { status: 400 });
    }
    // Empty string normalises to null so we don't store noise.
    const value = sig && sig.trim() ? sig : null;

    await getDb()
      .prepare("UPDATE mailboxes SET signature_html = ? WHERE id = ?")
      .bind(value, mailboxId)
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
