import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { searchContacts } from "@/lib/contacts";
import { errorResponse } from "../route";

// Typeahead endpoint for the compose To/Cc fields. Always scoped to one
// mailbox so suggestions reflect the current From identity.
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const sp = req.nextUrl.searchParams;
    const mailboxId = sp.get("mailbox_id");
    if (!mailboxId) {
      return NextResponse.json({ error: "mailbox_id required" }, { status: 400 });
    }
    const q = sp.get("q") ?? "";
    const limit = Number(sp.get("limit") ?? 8);
    const contacts = await searchContacts(user.id, mailboxId, q, limit);
    return NextResponse.json({ contacts });
  } catch (e) {
    return errorResponse(e);
  }
}
