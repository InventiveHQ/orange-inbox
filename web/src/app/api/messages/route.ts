import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { SendError, sendMessage } from "@/lib/send";

interface Body {
  from_mailbox_id?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  reply_to_message_id?: string;
  draft_id?: string;
  attachment_ids?: string[];
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

    const { messageId, threadId } = await sendMessage(user.id, {
      fromMailboxId: b.from_mailbox_id,
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
