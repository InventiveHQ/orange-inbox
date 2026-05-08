import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb, getEnv } from "@/lib/db";

// Lets the compose UI cancel a file that the user added then removed before
// sending. Idempotent — already-deleted IDs just return ok.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const row = await getDb()
      .prepare("SELECT r2_key FROM temp_uploads WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
      .first<{ r2_key: string }>();
    if (!row) return NextResponse.json({ ok: true });

    await getEnv().ATTACHMENTS.delete(row.r2_key);
    await getDb()
      .prepare("DELETE FROM temp_uploads WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
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
