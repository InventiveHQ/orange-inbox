import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canApplyLabelToThread, listThreadLabels } from "@/lib/labels";

// Thread-level labels: the schema stores label↔message rows, but Gmail-style
// labels are conceptually thread-scoped, so applying a label here inserts
// one message_labels row per message in the thread (and removing in the
// sibling DELETE handler nukes them all). Listing dedupes the same way.

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: threadId } = await ctx.params;

    // Confirm the user can see this thread before exposing its labels.
    const access = await getDb()
      .prepare(
        `SELECT 1
           FROM threads t
           INNER JOIN user_mailbox_access uma ON uma.mailbox_id = t.mailbox_id
          WHERE t.id = ? AND uma.user_id = ?
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

    // Insert one row per message; INSERT OR IGNORE so re-applying is a no-op.
    await getDb()
      .prepare(
        `INSERT OR IGNORE INTO message_labels (message_id, label_id)
           SELECT m.id, ?1 FROM messages m WHERE m.thread_id = ?2`,
      )
      .bind(labelId, threadId)
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
