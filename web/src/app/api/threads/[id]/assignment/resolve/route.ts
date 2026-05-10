import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { resolveAssignment, reopenAssignment } from "@/lib/assignments";

// Resolve / reopen lifecycle for thread assignments (issue #99).
//   POST   — mark the current assignment resolved. Idempotent w.r.t. nothing
//            (re-resolving a resolved row is rejected — the UI shouldn't
//            surface the button there, and a stale tab should refresh).
//   DELETE — reopen a resolved assignment (flip resolved_at/by back to NULL).
//            No-op on an already-active row so a stale "Reopen" click from
//            the resolved tab doesn't error if another teammate already
//            reopened.
//
// Permission lives in assignments.ts: caller must be a member of the
// thread's mailbox; not required to be the assignee or original resolver.

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;
    const result = await resolveAssignment(threadId, user.id);
    if (!result.ok) {
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "forbidden"
            ? 403
            : 400;
      return NextResponse.json({ error: result.code }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;
    const result = await reopenAssignment(threadId, user.id);
    if (!result.ok) {
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "forbidden"
            ? 403
            : 400;
      return NextResponse.json({ error: result.code }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
