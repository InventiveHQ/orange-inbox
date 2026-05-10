import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getActiveMailDbs } from "@/lib/mail-db";
import { getDb } from "@/lib/db";

// Lightweight recipients lookup used by the composer to auto-default the
// "From" identity when replying. ThreadView already has the original To/Cc,
// but we don't want to leak that data into ComposeOpenArgs (those callers
// are off-limits in this issue). The composer fetches them on its own via
// this endpoint.
//
// Authorisation: the user must have access to the mailbox the message
// landed in. We re-do the check here rather than trusting an upstream
// referer or query param.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    // Verify access via the control DB join. user_mailbox_access.mailbox_id
    // is enough; we fan out across mail DBs to find the actual to/cc JSON.
    const mailDbs = await getActiveMailDbs();
    let row:
      | {
          mailbox_id: string;
          to_json: string;
          cc_json: string | null;
        }
      | null = null;
    for (const { db } of mailDbs) {
      const r = await db
        .prepare("SELECT mailbox_id, to_json, cc_json FROM messages WHERE id = ?")
        .bind(id)
        .first<{ mailbox_id: string; to_json: string; cc_json: string | null }>();
      if (r) {
        row = r;
        break;
      }
    }
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const access = await getDb()
      .prepare(
        "SELECT 1 FROM user_mailbox_access WHERE user_id = ? AND mailbox_id = ? LIMIT 1",
      )
      .bind(user.id, row.mailbox_id)
      .first();
    if (!access) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    return NextResponse.json({
      to: parseAddrs(row.to_json),
      cc: parseAddrs(row.cc_json),
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

function parseAddrs(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .map(x => (x && typeof x === "object" && typeof x.addr === "string" ? x.addr : null))
      .filter((x): x is string => !!x);
  } catch {
    return [];
  }
}
