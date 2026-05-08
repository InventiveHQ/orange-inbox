import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { userCanAccessThread } from "@/lib/threads-mutate";

interface Body {
  snoozed_until?: number;
}

// POST { snoozed_until: <unix seconds> } — sets threads_index.snoozed_until.
// Caller must have any access role on the thread's mailbox. The mail-DB
// threads.snoozed_until column is left alone; source of truth for listing /
// snooze-clearing is the control-DB threads_index now.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!(await userCanAccessThread(user.id, id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const b = (await req.json().catch(() => null)) as Body | null;
    const until = typeof b?.snoozed_until === "number" ? Math.floor(b.snoozed_until) : NaN;
    if (!Number.isFinite(until)) {
      return NextResponse.json({ error: "snoozed_until required" }, { status: 400 });
    }
    if (until <= Math.floor(Date.now() / 1000)) {
      return NextResponse.json({ error: "snoozed_until must be in the future" }, { status: 400 });
    }
    await getDb()
      .prepare("UPDATE threads_index SET snoozed_until = ? WHERE thread_id = ?")
      .bind(until, id)
      .run();
    return NextResponse.json({ ok: true, snoozed_until: until });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE — un-snooze immediately.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!(await userCanAccessThread(user.id, id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    await getDb()
      .prepare("UPDATE threads_index SET snoozed_until = NULL WHERE thread_id = ?")
      .bind(id)
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
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
