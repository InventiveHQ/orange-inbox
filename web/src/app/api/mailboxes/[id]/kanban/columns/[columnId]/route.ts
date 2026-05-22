import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { deleteColumn, renameColumn } from "@/lib/kanban";

// A single Kanban column (migration 0054).
//   PATCH  — rename (body: { name }).
//   DELETE — remove the column; the board must keep at least one column, and
//            cards in the deleted column fall back to the first column.
//
// The column's mailbox (and the caller's access to it) is resolved from the
// column id inside lib/kanban.ts, so the `[id]` mailbox path segment is only
// for REST structure here.

interface PatchBody {
  name?: string;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; columnId: string }> },
) {
  try {
    const user = await requireUser();
    const { columnId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as PatchBody | null;
    const result = await renameColumn(columnId, body?.name ?? "", user.id);
    if (!result.ok) {
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "forbidden"
            ? 403
            : 400;
      return NextResponse.json({ error: result.code }, { status });
    }
    return NextResponse.json({ column: result.column });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; columnId: string }> },
) {
  try {
    const user = await requireUser();
    const { columnId } = await ctx.params;
    const result = await deleteColumn(columnId, user.id);
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
