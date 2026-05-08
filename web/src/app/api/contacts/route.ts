import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { ContactError, createContact, listContactsForUser } from "@/lib/contacts";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const mailboxId = req.nextUrl.searchParams.get("mailbox_id") ?? undefined;
    const contacts = await listContactsForUser(user.id, mailboxId);
    return NextResponse.json({ contacts });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PostBody {
  mailbox_id?: string;
  email?: string;
  name?: string | null;
  notes?: string | null;
  shared?: boolean;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PostBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    if (!b.mailbox_id) {
      return NextResponse.json({ error: "mailbox_id required" }, { status: 400 });
    }
    if (!b.email) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }
    const id = await createContact(user.id, {
      mailbox_id: b.mailbox_id,
      email: b.email,
      name: b.name ?? null,
      notes: b.notes ?? null,
      shared: b.shared !== false,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof ContactError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
