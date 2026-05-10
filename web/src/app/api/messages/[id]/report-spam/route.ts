import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  blockSenderAndArchiveThread,
  flagMessageAsSpamReported,
  lookupMessageForUser,
} from "@/lib/blocked-senders";

// Stronger version of block-sender: in addition to adding the sender to
// blocked_senders and archiving the thread, stamp
// `messages.spam_reported_by_user_id` so the message becomes part of the
// labelled spam corpus a future classifier can train on.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const msg = await lookupMessageForUser(user.id, id);
    if (!msg) return NextResponse.json({ error: "not_found" }, { status: 404 });

    await flagMessageAsSpamReported(msg, user.id);
    await blockSenderAndArchiveThread(msg);

    return NextResponse.json({
      ok: true,
      blocked: { mailbox_id: msg.mailboxId, addr: msg.fromAddr.toLowerCase() },
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
