import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDomainAdmin } from "@/lib/mailbox-access";

interface Body {
  domain_id?: string;
  local_part?: string;
  display_name?: string;
  is_catch_all?: boolean;
}

const LOCAL_PART_RE = /^[a-z0-9._+\-]+$/i;

// Domain admin creates a new mailbox in a domain they administer. Creator
// becomes mailbox owner so they can immediately read/send/manage it; other
// members are added later via the members endpoints.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as Body | null;
    if (!b?.domain_id) return NextResponse.json({ error: "domain_id required" }, { status: 400 });
    const localPart = b.local_part?.trim().toLowerCase();
    if (!localPart || !LOCAL_PART_RE.test(localPart)) {
      return NextResponse.json({ error: "invalid local_part" }, { status: 400 });
    }

    if (!(await isDomainAdmin(user.id, b.domain_id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const db = getDb();
    const dup = await db
      .prepare("SELECT id FROM mailboxes WHERE domain_id = ? AND local_part = ?")
      .bind(b.domain_id, localPart)
      .first<{ id: string }>();
    if (dup) return NextResponse.json({ error: "mailbox already exists" }, { status: 409 });

    const mailboxId = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          "INSERT INTO mailboxes (id, domain_id, local_part, display_name, is_catch_all) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(mailboxId, b.domain_id, localPart, b.display_name?.trim() || null, b.is_catch_all ? 1 : 0),
      db
        .prepare("INSERT INTO user_mailbox_access (user_id, mailbox_id, role) VALUES (?, ?, 'owner')")
        .bind(user.id, mailboxId),
    ]);

    return NextResponse.json({ mailbox: { id: mailboxId, domain_id: b.domain_id, local_part: localPart } }, { status: 201 });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
