import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { deleteNote } from "@/lib/thread-notes";

// Delete a note. Only the author can delete (deleteNote enforces).

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await deleteNote(id, user.id);
    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : 403;
      return NextResponse.json({ error: result.code }, { status });
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
