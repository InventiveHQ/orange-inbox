import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// Per-mailbox sender blocklist (issue #74). Inbound mail from a blocked
// (mailbox, addr) pair is still stored, but the email-worker forces the
// resulting thread into archived state, so it never reaches the inbox.
//
// GET   — every block visible to the current user, joined with the
//         mailbox label so the settings UI can group by mailbox.
// DELETE { mailbox_id, addr } — unblock. Body-payload DELETE is unusual
//         for REST but the natural-key here is composite, and it keeps
//         the URL space small.

export interface BlockedSenderRow {
  mailbox_id: string;
  addr: string;
  blocked_at: number;
  mailbox_label: string;
}

export async function GET() {
  try {
    const user = await requireUser();
    const { results } = await getDb()
      .prepare(
        `SELECT bs.mailbox_id, bs.addr, bs.blocked_at,
                mb.local_part || '@' || d.name AS mailbox_label
           FROM blocked_senders bs
           INNER JOIN user_mailbox_access uma
                   ON uma.mailbox_id = bs.mailbox_id AND uma.user_id = ?
           INNER JOIN mailboxes mb ON mb.id = bs.mailbox_id
           INNER JOIN domains   d  ON d.id  = mb.domain_id
          ORDER BY bs.blocked_at DESC`,
      )
      .bind(user.id)
      .all<BlockedSenderRow>();
    return NextResponse.json({ blocked_senders: results ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

interface DeleteBody {
  mailbox_id?: string;
  addr?: string;
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as DeleteBody | null;
    const mailboxId = b?.mailbox_id;
    const addrRaw = b?.addr;
    if (!mailboxId || !addrRaw) {
      return NextResponse.json({ error: "mailbox_id and addr required" }, { status: 400 });
    }
    const addr = addrRaw.trim().toLowerCase();

    const access = await getDb()
      .prepare(
        "SELECT 1 AS ok FROM user_mailbox_access WHERE user_id = ? AND mailbox_id = ?",
      )
      .bind(user.id, mailboxId)
      .first<{ ok: number }>();
    if (!access) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    await getDb()
      .prepare("DELETE FROM blocked_senders WHERE mailbox_id = ? AND addr = ?")
      .bind(mailboxId, addr)
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
