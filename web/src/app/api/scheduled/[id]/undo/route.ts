import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { DraftError, createDraft } from "@/lib/drafts";

interface PayloadJson {
  from_mailbox_id?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  reply_to_message_id?: string | null;
  attachment_ids?: string[];
}

// Cancel a pending undo_send (or scheduled) row and reconstitute its payload
// as a draft. Returns the new draft_id so the compose modal can reopen on
// the original content for editing or re-send.
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const db = getDb();

    const row = await db
      .prepare(
        `SELECT id, payload_json, status FROM scheduled_messages
          WHERE id = ? AND user_id = ?`,
      )
      .bind(id, user.id)
      .first<{ id: string; payload_json: string; status: string }>();
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.status !== "pending") {
      // Already sent / failed / cancelled — too late to undo.
      return NextResponse.json({ error: "already_finalised", status: row.status }, { status: 409 });
    }

    // Atomically claim the row before we create the draft. If status changes
    // out from under us (cron picks it up between the SELECT and UPDATE) the
    // UPDATE returns 0 changes and we bail without creating a stale draft.
    const claim = await db
      .prepare(
        `UPDATE scheduled_messages
            SET status = 'cancelled'
          WHERE id = ? AND user_id = ? AND status = 'pending'`,
      )
      .bind(id, user.id)
      .run();
    if (!claim.meta.changes) {
      return NextResponse.json({ error: "already_finalised" }, { status: 409 });
    }

    let payload: PayloadJson;
    try {
      payload = JSON.parse(row.payload_json) as PayloadJson;
    } catch {
      return NextResponse.json({ error: "payload_parse_error" }, { status: 500 });
    }
    if (!payload.from_mailbox_id) {
      return NextResponse.json({ error: "payload_invalid" }, { status: 500 });
    }

    const draftId = await createDraft(user.id, {
      mailbox_id: payload.from_mailbox_id,
      to: payload.to ?? [],
      cc: payload.cc ?? [],
      bcc: payload.bcc ?? [],
      subject: payload.subject ?? "",
      body: payload.body ?? "",
      reply_to_message_id: payload.reply_to_message_id ?? null,
    });

    return NextResponse.json({ ok: true, draft_id: draftId });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (e instanceof DraftError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error("undo scheduled error", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
