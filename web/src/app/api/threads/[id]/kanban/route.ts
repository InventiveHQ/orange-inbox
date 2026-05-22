import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { moveThread } from "@/lib/kanban";

// Kanban placement for a thread (migration 0054).
//   PUT — move the thread to a column (body: { column_id }).
//
// Permission lives in lib/kanban.ts moveThread: the caller must be a member
// of the thread's mailbox, and the column must belong to that same mailbox.

interface PutBody {
  column_id?: string;
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as PutBody | null;
    if (!body?.column_id) {
      return NextResponse.json({ error: "column_id required" }, { status: 400 });
    }
    const result = await moveThread(threadId, body.column_id, user.id);
    if (!result.ok) {
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "bad_column"
            ? 400
            : 403;
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
