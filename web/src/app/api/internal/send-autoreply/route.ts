import { NextRequest, NextResponse } from "next/server";
import { getDb, getEnv } from "@/lib/db";

interface Body {
  mailboxId?: string;
  toAddr?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
}

interface MailboxRow {
  local_part: string;
  display_name: string | null;
  domain_name: string;
}

// Internal endpoint hit by the email-worker over its WEB service binding when
// a mailbox's vacation auto-responder fires. Auth: shared INTERNAL_SECRET
// header, same pattern as notify-new-message and dispatch-scheduled. The
// service binding itself is private — external traffic can't reach this
// route in production.
//
// We do NOT mirror the lib/send.ts persistence flow: auto-replies are
// transient courtesy messages and shouldn't pollute the mailbox's outbox or
// thread the original inbound. Just hand the bytes to env.EMAIL.send and
// stamp the cooldown ledger.
export async function POST(req: NextRequest) {
  try {
    const env = getEnv() as unknown as {
      INTERNAL_SECRET?: string;
      EMAIL: {
        send: (msg: {
          from: string | { name: string; email: string };
          to: string;
          subject: string;
          text: string;
          html?: string;
          headers?: Record<string, string>;
        }) => Promise<unknown>;
      };
    };
    const expected = env.INTERNAL_SECRET;
    if (!expected) {
      return NextResponse.json({ error: "internal_secret_not_configured" }, { status: 500 });
    }
    if (req.headers.get("x-internal-secret") !== expected) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const b = (await req.json().catch(() => null)) as Body | null;
    if (!b?.mailboxId || !b.toAddr || !b.subject || !b.bodyText) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }

    const db = getDb();
    const mailbox = await db
      .prepare(
        `SELECT mb.local_part, mb.display_name, d.name AS domain_name
           FROM mailboxes mb
           INNER JOIN domains d ON d.id = mb.domain_id
          WHERE mb.id = ?`,
      )
      .bind(b.mailboxId)
      .first<MailboxRow>();
    if (!mailbox) {
      return NextResponse.json({ error: "mailbox_not_found" }, { status: 404 });
    }

    const fromAddr = `${mailbox.local_part}@${mailbox.domain_name}`;
    const fromName = mailbox.display_name?.trim() || undefined;

    // RFC 3834 marker so downstream auto-responders / vacation systems on the
    // recipient side can tell this was an auto-reply and stay quiet.
    // Cloudflare's send_email binding only whitelists a small set of headers
    // (Auto-Submitted is among them).
    const headers: Record<string, string> = {
      "Auto-Submitted": "auto-replied",
    };

    try {
      await env.EMAIL.send({
        from: fromName ? { name: fromName, email: fromAddr } : fromAddr,
        to: b.toAddr,
        subject: b.subject,
        text: b.bodyText,
        ...(b.bodyHtml ? { html: b.bodyHtml } : {}),
        headers,
      });
    } catch (e) {
      // Cloudflare's send_email binding only delivers to verified
      // destinations. If the original sender isn't verified, the auto-reply
      // attempt fails — log and ack so we don't churn retries; the cooldown
      // ledger isn't stamped on failure so the next inbound from the same
      // address gets another shot once the destination is verified.
      console.warn("send-autoreply env.EMAIL.send failed", {
        mailboxId: b.mailboxId,
        toAddr: b.toAddr,
        error: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json({ ok: false, skipped: "send_failed" });
    }

    // Stamp the cooldown ledger so the next inbound from the same address
    // within `cooldown_hours` doesn't trigger another reply. The ledger is
    // append-only; cooldown logic lives in email-worker/autoresponder.ts.
    try {
      await db
        .prepare(
          `INSERT INTO mailbox_autoresponder_log (mailbox_id, to_addr, sent_at)
           VALUES (?, ?, unixepoch())`,
        )
        .bind(b.mailboxId, b.toAddr)
        .run();
    } catch (e) {
      // Duplicate (mailbox_id, to_addr, sent_at) is theoretically possible if
      // two replies fire in the same second; treat as a no-op.
      console.warn("autoresponder log insert failed", e);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("send-autoreply error", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
