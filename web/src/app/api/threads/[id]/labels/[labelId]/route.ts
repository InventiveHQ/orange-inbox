import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { logAudit, mailboxIdForThread } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { canApplyLabelToThread } from "@/lib/labels";
import { getMailDbForThread } from "@/lib/mail-db";

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

    const mailDb = await getMailDbForThread(threadId);
    const controlDb = getDb();

    // Drop per-message rows (mail DB) and the listing-cache row (control).
    // Done in parallel; no dependency between them.
    await Promise.all([
      mailDb
        .prepare(
          `DELETE FROM message_labels
            WHERE label_id = ?1
              AND message_id IN (SELECT id FROM messages WHERE thread_id = ?2)`,
        )
        .bind(labelId, threadId)
        .run(),
      controlDb
        .prepare("DELETE FROM thread_labels WHERE thread_id = ? AND label_id = ?")
        .bind(threadId, labelId)
        .run(),
    ]);

    try {
      const mailboxId = await mailboxIdForThread(threadId);
      if (mailboxId) {
        await logAudit({
          userId: user.id,
          mailboxId,
          threadId,
          action: "label_remove",
          payload: { label_id: labelId },
        });
      }
    } catch (err) {
      console.error("audit label remove failed", err);
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
