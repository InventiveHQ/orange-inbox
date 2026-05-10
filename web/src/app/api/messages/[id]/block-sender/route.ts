import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  blockSenderAndArchiveThread,
  lookupMessageForUser,
} from "@/lib/blocked-senders";

// Block the sender of `messageId` for the message's mailbox and archive
// the current thread so the user isn't staring at the spam they just
// blocked. Future inbound from the same address lands archived from the
// start (gated in email-worker/src/store.ts).
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const msg = await lookupMessageForUser(user.id, id);
    if (!msg) return NextResponse.json({ error: "not_found" }, { status: 404 });

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
