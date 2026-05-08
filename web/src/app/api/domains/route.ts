import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listDomainsForUser } from "@/lib/queries";

export async function GET() {
  try {
    const user = await requireUser();
    const domains = await listDomainsForUser(user.id);
    return NextResponse.json({ domains });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as
      | { name?: string; display_name?: string; default_local_part?: string }
      | null;

    const name = body?.name?.trim().toLowerCase();
    if (!name || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(name)) {
      return NextResponse.json({ error: "invalid domain name" }, { status: 400 });
    }

    const db = getDb();
    const existing = await db.prepare("SELECT id FROM domains WHERE name = ?").bind(name).first<{ id: string }>();
    if (existing) {
      return NextResponse.json({ error: "domain already registered" }, { status: 409 });
    }

    const domainId = crypto.randomUUID();
    const mailboxId = crypto.randomUUID();
    const localPart = body?.default_local_part?.trim().toLowerCase() || "hello";

    await db.batch([
      db
        .prepare("INSERT INTO domains (id, name, display_name) VALUES (?, ?, ?)")
        .bind(domainId, name, body?.display_name?.trim() || null),
      db
        .prepare(
          "INSERT INTO mailboxes (id, domain_id, local_part, is_catch_all) VALUES (?, ?, ?, 1)",
        )
        .bind(mailboxId, domainId, localPart),
      db
        .prepare("INSERT INTO user_domain_access (user_id, domain_id, role) VALUES (?, ?, 'admin')")
        .bind(user.id, domainId),
      // Domain admin alone doesn't grant mailbox access — explicitly seed the
      // creator as owner of the default catch-all mailbox so they can read
      // and send from it without a separate invite step.
      db
        .prepare("INSERT INTO user_mailbox_access (user_id, mailbox_id, role) VALUES (?, ?, 'owner')")
        .bind(user.id, mailboxId),
    ]);

    return NextResponse.json({ domain: { id: domainId, name, role: "admin" } }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
