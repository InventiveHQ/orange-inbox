import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  DraftError,
  type DraftPayload,
  createDraft,
  listDraftsForUser,
} from "@/lib/drafts";

export async function GET() {
  try {
    const user = await requireUser();
    const drafts = await listDraftsForUser(user.id);
    return NextResponse.json({ drafts });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const payload = await readPayload(req);
    if (payload instanceof NextResponse) return payload;
    const id = await createDraft(user.id, payload);
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

interface BodyShape {
  mailbox_id?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  reply_to_message_id?: string | null;
}

export async function readPayload(req: NextRequest): Promise<DraftPayload | NextResponse> {
  const b = (await req.json().catch(() => null)) as BodyShape | null;
  if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  if (!b.mailbox_id) {
    return NextResponse.json({ error: "mailbox_id required" }, { status: 400 });
  }
  return {
    mailbox_id: b.mailbox_id,
    to: cleanList(b.to),
    cc: cleanList(b.cc),
    bcc: cleanList(b.bcc),
    subject: b.subject ?? "",
    body: b.body ?? "",
    reply_to_message_id: b.reply_to_message_id ?? null,
  };
}

function cleanList(xs: string[] | undefined): string[] {
  if (!xs) return [];
  return xs.map(s => s.trim()).filter(Boolean);
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof DraftError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
