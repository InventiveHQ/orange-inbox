import { NextRequest, NextResponse } from "next/server";
import { getDb, getEnv } from "@/lib/db";
import { notify } from "@/lib/notify";
import { sendMessage, SendError } from "@/lib/send";

interface Body {
  id?: string;
  secret?: string;
}

interface PayloadJson {
  from_mailbox_id?: string;
  // Optional promoted-alias id; the parent scheduler captures this when the
  // composer picks an alias as the From identity. Forwarded to sendMessage
  // unchanged — re-validation happens there.
  send_as_alias_id?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  reply_to_message_id?: string;
  draft_id?: string;
  attachment_ids?: string[];
  // #66 / #69 forwarding through the scheduled-dispatch path. Same shape the
  // composer / /api/messages route accepts, snapshotted verbatim at queue
  // time. Re-validated by sendMessage at dispatch time.
  confidential?: { expires_at?: number; passcode?: string | null };
  track_opens?: boolean;
}

// Internal endpoint hit by the email-worker's cron (via service binding) to
// dispatch a scheduled_messages row. Bypasses Cloudflare Access — the only
// auth layer is the shared INTERNAL_SECRET env var, which the email-worker
// has and external callers do not. Service bindings are private so the
// route is unreachable except through that path in production.
export async function POST(req: NextRequest) {
  try {
    const env = getEnv() as unknown as { INTERNAL_SECRET?: string };
    const expected = env.INTERNAL_SECRET;
    if (!expected) {
      return NextResponse.json({ error: "internal_secret_not_configured" }, { status: 500 });
    }
    const b = (await req.json().catch(() => null)) as Body | null;
    if (!b?.id || b.secret !== expected) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const db = getDb();
    const row = await db
      .prepare(
        `SELECT id, user_id, payload_json, status FROM scheduled_messages WHERE id = ?`,
      )
      .bind(b.id)
      .first<{ id: string; user_id: string; payload_json: string; status: string }>();
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (row.status !== "pending") {
      return NextResponse.json({ ok: true, status: row.status, skipped: true });
    }

    let payload: PayloadJson;
    try {
      payload = JSON.parse(row.payload_json) as PayloadJson;
    } catch {
      await markFailed(b.id, "payload_parse_error");
      return NextResponse.json({ error: "payload_parse_error" }, { status: 500 });
    }

    if (!payload.from_mailbox_id || !Array.isArray(payload.to) || !payload.body) {
      await markFailed(b.id, "payload_invalid");
      return NextResponse.json({ error: "payload_invalid" }, { status: 400 });
    }

    // Re-validate confidential expiry against *current* time, not queue
    // time — a stale row that's been sitting in the queue past its expiry
    // would be useless anyway. Pass through unchanged for the happy path.
    let confidential: { expiresAt: number; passcode?: string | null } | undefined;
    if (payload.confidential) {
      const expires = Number(payload.confidential.expires_at);
      if (Number.isFinite(expires) && expires > Math.floor(Date.now() / 1000)) {
        confidential = {
          expiresAt: Math.floor(expires),
          passcode: payload.confidential.passcode ?? null,
        };
      } else {
        await markFailed(b.id, "confidential_expired_before_send");
        return NextResponse.json({ error: "confidential_expired" }, { status: 400 });
      }
    }

    try {
      const result = await sendMessage(row.user_id, {
        fromMailboxId: payload.from_mailbox_id,
        sendAsAliasId: payload.send_as_alias_id,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject ?? "",
        body: payload.body,
        replyToMessageId: payload.reply_to_message_id,
        draftId: payload.draft_id,
        attachmentIds: payload.attachment_ids,
        confidential,
        trackOpens: payload.track_opens === true,
      });
      await db
        .prepare(
          "UPDATE scheduled_messages SET status = 'sent', sent_at = unixepoch() WHERE id = ?",
        )
        .bind(b.id)
        .run();
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      const reason = e instanceof SendError ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : String(e));
      await markFailed(b.id, reason);
      const env2 = getEnv() as unknown as { ALERT_WEBHOOK_URL?: string };
      await notify(env2.ALERT_WEBHOOK_URL, "error", "Scheduled send failed", {
        scheduled_id: b.id,
        reason,
      });
      return NextResponse.json({ error: "send_failed", reason }, { status: 500 });
    }
  } catch (e) {
    const env2 = getEnv() as unknown as { ALERT_WEBHOOK_URL?: string };
    await notify(env2.ALERT_WEBHOOK_URL, "error", "dispatch-scheduled crashed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

async function markFailed(id: string, reason: string) {
  await getDb()
    .prepare(
      "UPDATE scheduled_messages SET status = 'failed', error_message = ? WHERE id = ?",
    )
    .bind(reason.slice(0, 500), id)
    .run();
}
