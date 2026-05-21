import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { SendError, sendMessage } from "@/lib/send";

// #66 Confidential mode — defence-in-depth upper bound on the client-supplied
// `expires_at`. send.ts enforces the same 30-day cap as the authoritative
// check (it covers every confidential creation path); we mirror it here so an
// obviously-out-of-range value is rejected with a clean 400 before send.ts.
const CONFIDENTIAL_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

interface Body {
  from_mailbox_id?: string;
  // Optional promoted-alias id. When set, the From line uses the alias's
  // local_part / display_name / signature instead of the mailbox's. The
  // alias must belong to the same mailbox the user has access to; the send
  // path re-verifies before handing bytes to env.EMAIL.send().
  send_as_alias_id?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  reply_to_message_id?: string;
  draft_id?: string;
  attachment_ids?: string[];
  // #66 Confidential mode. expires_at is unix seconds (capped at 30 days
  // out), passcode is an optional high-entropy alphanumeric string.
  // Empty/missing passcode means "no prompt".
  confidential?: {
    expires_at?: number;
    passcode?: string | null;
  };
  // #69 Opt-in read receipts.
  track_opens?: boolean;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as Body | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    if (!b.from_mailbox_id) return NextResponse.json({ error: "from_mailbox_id required" }, { status: 400 });
    if (!Array.isArray(b.to) || b.to.length === 0) {
      return NextResponse.json({ error: "to required" }, { status: 400 });
    }
    if (!b.body) return NextResponse.json({ error: "body required" }, { status: 400 });

    // Confidential mode requires an absolute expiry — we let send.ts re-check
    // the bound and re-validate the passcode shape, but reject obviously
    // malformed input here to keep the SendError path clean.
    let confidential: { expiresAt: number; passcode?: string | null } | undefined;
    if (b.confidential) {
      const nowSec = Math.floor(Date.now() / 1000);
      const expires = Number(b.confidential.expires_at);
      if (!Number.isFinite(expires) || expires <= nowSec) {
        return NextResponse.json(
          { error: "confidential.expires_at must be a future unix timestamp" },
          { status: 400 },
        );
      }
      if (expires > nowSec + CONFIDENTIAL_MAX_TTL_SECONDS) {
        return NextResponse.json(
          { error: "confidential.expires_at can be at most 30 days in the future" },
          { status: 400 },
        );
      }
      confidential = { expiresAt: Math.floor(expires), passcode: b.confidential.passcode ?? null };
    }

    const { messageId, threadId } = await sendMessage(user.id, {
      fromMailboxId: b.from_mailbox_id,
      sendAsAliasId: b.send_as_alias_id,
      to: cleanList(b.to),
      cc: cleanList(b.cc),
      bcc: cleanList(b.bcc),
      subject: b.subject ?? "",
      body: b.body,
      replyToMessageId: b.reply_to_message_id,
      draftId: b.draft_id,
      attachmentIds: Array.isArray(b.attachment_ids)
        ? b.attachment_ids.filter(x => typeof x === "string")
        : undefined,
      confidential,
      trackOpens: b.track_opens === true,
    });
    return NextResponse.json({ messageId, threadId }, { status: 201 });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (e instanceof SendError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

function cleanList(xs: string[] | undefined): string[] {
  if (!xs) return [];
  return xs.map(s => s.trim()).filter(Boolean);
}
