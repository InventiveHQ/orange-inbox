import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canApplyLabelToThread } from "@/lib/labels";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; labelId: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId, labelId } = await ctx.params;

    // Same access predicate as apply: any role on the thread's mailbox plus
    // the label being applicable to that mailbox.
    if (!(await canApplyLabelToThread(user.id, labelId, threadId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    await getDb()
      .prepare(
        `DELETE FROM message_labels
          WHERE label_id = ?1
            AND message_id IN (SELECT id FROM messages WHERE thread_id = ?2)`,
      )
      .bind(labelId, threadId)
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
