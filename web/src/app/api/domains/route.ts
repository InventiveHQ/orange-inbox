import { NextRequest, NextResponse } from "next/server";
import { ForbiddenError, UnauthenticatedError, requireAdmin, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listAllDomains, listDomainsForUser } from "@/lib/queries";

export async function GET() {
  try {
    const user = await requireUser();
    const domains = user.is_admin ? await listAllDomains() : await listDomainsForUser(user.id);
    return NextResponse.json({ domains });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAdmin();
    const body = (await req.json().catch(() => null)) as
      | {
          name?: string;
          display_name?: string;
          default_local_part?: string;
          create_catch_all?: boolean;
        }
      | null;

    const name = body?.name?.trim().toLowerCase();
    if (!name || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(name)) {
      return NextResponse.json({ error: "invalid domain name" }, { status: 400 });
    }

    const createCatchAll = body?.create_catch_all !== false;
    const localPart = (body?.default_local_part?.trim().toLowerCase() || "hello");
    if (createCatchAll && !/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(localPart)) {
      return NextResponse.json({ error: "invalid local part" }, { status: 400 });
    }

    const db = getDb();
    const existing = await db.prepare("SELECT id FROM domains WHERE name = ?").bind(name).first<{ id: string }>();
    if (existing) {
      return NextResponse.json({ error: "domain already registered" }, { status: 409 });
    }

    const domainId = crypto.randomUUID();
    const stmts = [
      db
        .prepare("INSERT INTO domains (id, name, display_name) VALUES (?, ?, ?)")
        .bind(domainId, name, body?.display_name?.trim() || null),
    ];
    if (createCatchAll) {
      const mailboxId = crypto.randomUUID();
      stmts.push(
        db
          .prepare(
            "INSERT INTO mailboxes (id, domain_id, local_part, is_catch_all) VALUES (?, ?, ?, 1)",
          )
          .bind(mailboxId, domainId, localPart),
        // Seed the creating admin as a member of the default catch-all so they
        // can read/send from it. Management gating is global (users.is_admin),
        // so we no longer write a user_domain_access row.
        db
          .prepare("INSERT INTO user_mailbox_access (user_id, mailbox_id, role) VALUES (?, ?, 'owner')")
          .bind(user.id, mailboxId),
      );
    }
    await db.batch(stmts);

    return NextResponse.json({ domain: { id: domainId, name } }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
