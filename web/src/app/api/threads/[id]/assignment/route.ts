import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { assignThread, getAssignment, unassignThread } from "@/lib/assignments";
import { userCanAccessThread } from "@/lib/threads-mutate";

// Thread assignment endpoint (issue #27).
//   GET    — current assignment, or `{ assignment: null }` when unassigned.
//   PUT    — assign to a user (body: { assignee_id }). Self-claim: pass own
//            user id. Replaces any existing assignment.
//   DELETE — unassign (clear). Idempotent.
//
// Permission model lives in assignments.ts:
//   - assigner must be a member of the thread's mailbox
//   - assignee must also be a member of the thread's mailbox

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;

    // Gate on read access — without this an arbitrary user could probe
    // "who's assigned to this thread id?" against any UUID.
    if (!(await userCanAccessThread(user.id, threadId))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const assignment = await getAssignment(threadId);
    return NextResponse.json({ assignment });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PutBody {
  assignee_id?: string;
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as PutBody | null;
    if (!body?.assignee_id) {
      return NextResponse.json({ error: "assignee_id required" }, { status: 400 });
    }
    const result = await assignThread(threadId, body.assignee_id, user.id);
    if (!result.ok) {
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "assignee_not_member"
            ? 400
            : 403;
      return NextResponse.json({ error: result.code }, { status });
    }
    return NextResponse.json({ assignment: result.assignment });
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
    const result = await unassignThread(threadId, user.id);
    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : 403;
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
