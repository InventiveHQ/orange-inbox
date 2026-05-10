import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { addNote, listNotes } from "@/lib/thread-notes";
import { userCanAccessThread } from "@/lib/threads-mutate";

// Per-thread internal notes (issue #27).
//   GET  — list notes on the thread (any mailbox member can read).
//   POST — add a note. Body: { body: string }. Empty bodies rejected.

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;
    if (!(await userCanAccessThread(user.id, threadId))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const notes = await listNotes(threadId);
    return NextResponse.json({ notes });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PostBody {
  body?: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;
    const b = (await req.json().catch(() => null)) as PostBody | null;
    if (!b?.body || typeof b.body !== "string") {
      return NextResponse.json({ error: "body required" }, { status: 400 });
    }
    const result = await addNote(threadId, user.id, b.body);
    if (!result.ok) {
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "empty"
            ? 400
            : 403;
      return NextResponse.json({ error: result.code }, { status });
    }
    return NextResponse.json({ note: result.note });
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
