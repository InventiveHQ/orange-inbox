import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// Persists the user's sidebar mailbox order (issue #52). The default
// alphabetical order is encoded by `sort_order = 0` rows — the first time
// a user drags, we write 1..N over every accessible mailbox so the entire
// list becomes deterministic. Subsequent drags rewrite the same range.
//
// Body shape: { order: string[] } — mailbox_ids in the desired display
// order. The endpoint validates every id belongs to a mailbox the user
// actually has access to (no smuggling other users' rows in via PATCH).
// IDs not in the array fall through to the alphabetical tail with
// sort_order = 0 — useful when a new mailbox is granted to the user
// after they've already arranged their sidebar.

interface PatchBody {
  order?: unknown;
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as PatchBody | null;
    if (!body || !Array.isArray(body.order)) {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    // Sanitise + dedupe. Repeated ids in the array would let a caller pin
    // a mailbox to two positions, so reject those instead of silently
    // collapsing.
    const order: string[] = [];
    const seen = new Set<string>();
    for (const item of body.order) {
      if (typeof item !== "string" || item.length === 0) {
        return NextResponse.json({ error: "invalid_order" }, { status: 400 });
      }
      if (seen.has(item)) {
        return NextResponse.json({ error: "duplicate_id" }, { status: 400 });
      }
      seen.add(item);
      order.push(item);
    }

    const db = getDb();

    // Every mailbox the user has access to. We need this for the
    // membership check below — a PATCH must only mention rows the user
    // can actually see. Doing the lookup up front lets us reject the
    // whole request before touching any rows.
    const { results } = await db
      .prepare("SELECT mailbox_id FROM user_mailbox_access WHERE user_id = ?")
      .bind(user.id)
      .all<{ mailbox_id: string }>();
    const accessible = new Set((results ?? []).map(r => r.mailbox_id));

    for (const id of order) {
      if (!accessible.has(id)) {
        return NextResponse.json({ error: "forbidden_mailbox" }, { status: 403 });
      }
    }

    if (order.length === 0) {
      return NextResponse.json({ ok: true });
    }

    // One UPDATE per row. D1 batches the statements in a single
    // round-trip, so this stays cheap even for users with many mailboxes
    // — and the (user_id, mailbox_id) PK keeps each lookup O(1).
    const stmts = order.map((id, index) =>
      db
        .prepare(
          "UPDATE user_mailbox_access SET sort_order = ? WHERE user_id = ? AND mailbox_id = ?",
        )
        .bind(index + 1, user.id, id),
    );
    await db.batch(stmts);

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
