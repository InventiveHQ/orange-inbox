import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listScheduledForUser } from "@/lib/scheduled";

interface ScheduleBody {
  scheduled_for?: number;
  // 'scheduled' (default) for explicit Schedule-send; 'undo_send' for the
  // short hold window applied by Undo Send. Only difference is whether the
  // row appears in the user-facing Scheduled list.
  kind?: "scheduled" | "undo_send";
  // Plus the same fields as /api/messages POST body.
  from_mailbox_id?: string;
  send_as_alias_id?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  reply_to_message_id?: string;
  draft_id?: string;
  attachment_ids?: string[];
  // #66 / #69 — forwarded verbatim into the payload snapshot so the eventual
  // dispatcher passes them through to sendMessage. Validated at dispatch
  // time, not here.
  confidential?: { expires_at?: number; passcode?: string | null };
  track_opens?: boolean;
}

export async function GET() {
  try {
    const user = await requireUser();
    const items = await listScheduledForUser(user.id);
    return NextResponse.json({ items });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST: queue a send for later. Validation is deliberately loose here — the
// send pipeline (lib/send.ts) re-validates ownership / role / payload at
// dispatch time, so we don't need to duplicate that logic.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as ScheduleBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const scheduledFor = typeof b.scheduled_for === "number" ? Math.floor(b.scheduled_for) : NaN;
    if (!Number.isFinite(scheduledFor)) {
      return NextResponse.json({ error: "scheduled_for required" }, { status: 400 });
    }
    if (scheduledFor <= Math.floor(Date.now() / 1000)) {
      return NextResponse.json({ error: "scheduled_for must be in the future" }, { status: 400 });
    }
    if (!b.from_mailbox_id) return NextResponse.json({ error: "from_mailbox_id required" }, { status: 400 });
    if (!Array.isArray(b.to) || b.to.length === 0) {
      return NextResponse.json({ error: "to required" }, { status: 400 });
    }
    if (!b.body) return NextResponse.json({ error: "body required" }, { status: 400 });

    // Snapshot the payload so cancellations of attached files / drafts after
    // scheduling don't break the dispatch. (Attachment ownership is still
    // re-checked at dispatch time — if the user removes an upload, the send
    // will fail with attachment_not_found.)
    const payload = {
      from_mailbox_id: b.from_mailbox_id,
      send_as_alias_id: b.send_as_alias_id,
      to: b.to,
      cc: b.cc,
      bcc: b.bcc,
      subject: b.subject ?? "",
      body: b.body,
      reply_to_message_id: b.reply_to_message_id,
      draft_id: b.draft_id,
      attachment_ids: b.attachment_ids,
      confidential: b.confidential,
      track_opens: b.track_opens === true ? true : undefined,
    };

    const kind = b.kind === "undo_send" ? "undo_send" : "scheduled";
    const id = crypto.randomUUID();
    await getDb()
      .prepare(
        `INSERT INTO scheduled_messages (id, user_id, scheduled_for, payload_json, status, kind)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(id, user.id, scheduledFor, JSON.stringify(payload), kind)
      .run();
    return NextResponse.json({ id, scheduled_for: scheduledFor, kind }, { status: 201 });
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
