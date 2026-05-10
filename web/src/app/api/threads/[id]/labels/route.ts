import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { logAudit, mailboxIdForThread } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { canApplyLabelToThread, listThreadLabels } from "@/lib/labels";
import { getMailDbForThread } from "@/lib/mail-db";

// Thread-level labels: the per-message message_labels rows live in the
// thread's mail DB (one per message in the thread), and a denormalised
// (thread_id, label_id) row lives in the control-DB thread_labels table so
// the inbox listing can show label chips with one SQL.
//
// Apply / remove must update both: mail DB for accuracy on individual
// messages, control for listing speed.

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;

    // Confirm the user can see this thread before exposing its labels.
    // threads_index lives in control alongside user_mailbox_access, so this
    // is a single control-DB query (unlike the old version that joined
    // against mail-DB threads).
    const access = await getDb()
      .prepare(
        `SELECT 1
           FROM threads_index ti
           INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
          WHERE ti.thread_id = ? AND uma.user_id = ?
          LIMIT 1`,
      )
      .bind(threadId, user.id)
      .first();
    if (!access) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const labels = await listThreadLabels(threadId);
    return NextResponse.json({ labels });
  } catch (e) {
    return errorResponse(e);
  }
}

interface ApplyBody {
  label_id?: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;

    const b = (await req.json().catch(() => null)) as ApplyBody | null;
    const labelId = b?.label_id;
    if (!labelId) return NextResponse.json({ error: "label_id required" }, { status: 400 });

    if (!(await canApplyLabelToThread(user.id, labelId, threadId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const mailDb = await getMailDbForThread(threadId);
    const controlDb = getDb();

    // Per-message rows in the thread's mail DB, plus the denormalised
    // (thread, label) row in control's thread_labels — used by the listing
    // query to render label chips without a cross-DB JOIN.
    await Promise.all([
      mailDb
        .prepare(
          `INSERT OR IGNORE INTO message_labels (message_id, label_id)
             SELECT m.id, ?1 FROM messages m WHERE m.thread_id = ?2`,
        )
        .bind(labelId, threadId)
        .run(),
      controlDb
        .prepare(
          `INSERT INTO thread_labels (thread_id, label_id) VALUES (?, ?)
           ON CONFLICT (thread_id, label_id) DO NOTHING`,
        )
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
          action: "label_add",
          payload: { label_id: labelId },
        });
      }
    } catch (err) {
      console.error("audit label apply failed", err);
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
