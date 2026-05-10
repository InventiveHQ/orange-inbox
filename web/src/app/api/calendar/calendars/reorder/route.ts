import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { PERSONAL_CALENDAR, userHasMailboxAccess } from "@/lib/calendar";
import { getDb } from "@/lib/db";

// POST /api/calendar/calendars/reorder (#97)
//
// Bulk-set sort_order for the calendars the user can see, mirroring the
// shape of /api/me/mailbox-order (#52). One round-trip per drag rather
// than N PATCH /calendars calls.
//
// Body: { order: [{ id: "personal" | mailbox_id, sort_order: int }, ...] }
//
// "personal" maps to mailbox_id IS NULL on the row — the same convention
// as the rest of the calendar API. Each id must be a calendar the user
// can actually see; access is enforced on every entry. We materialise a
// pref row (with defaults) for any calendar the user hasn't customised
// yet — without it, the UPDATE would no-op and the order wouldn't stick.

interface OrderEntry {
  id: string;
  sort_order: number;
}

interface PostBody {
  order?: OrderEntry[];
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as PostBody | null;
    if (!body || !Array.isArray(body.order)) {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    // Sanitise + dedupe. The same id appearing twice would be ambiguous
    // (two sort_orders for one row); reject rather than silently using
    // the last one.
    const cleaned: OrderEntry[] = [];
    const seen = new Set<string>();
    for (const entry of body.order) {
      if (!entry || typeof entry !== "object") {
        return NextResponse.json({ error: "invalid_entry" }, { status: 400 });
      }
      const id = (entry as { id?: unknown }).id;
      const so = (entry as { sort_order?: unknown }).sort_order;
      if (typeof id !== "string" || id.length === 0) {
        return NextResponse.json({ error: "invalid_id" }, { status: 400 });
      }
      const v = Number(so);
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        return NextResponse.json({ error: "invalid_sort_order" }, { status: 400 });
      }
      if (seen.has(id)) {
        return NextResponse.json({ error: "duplicate_id" }, { status: 400 });
      }
      seen.add(id);
      cleaned.push({ id, sort_order: v });
    }

    // Resolve "personal" → null and check mailbox access for every other
    // id. Doing this up front means one bad id rejects the whole batch
    // instead of half-applying.
    const resolved: { mailboxId: string | null; sort_order: number }[] = [];
    for (const e of cleaned) {
      if (e.id === PERSONAL_CALENDAR) {
        resolved.push({ mailboxId: null, sort_order: e.sort_order });
        continue;
      }
      if (!(await userHasMailboxAccess(user.id, e.id))) {
        return NextResponse.json({ error: "forbidden_mailbox" }, { status: 403 });
      }
      resolved.push({ mailboxId: e.id, sort_order: e.sort_order });
    }

    if (resolved.length === 0) {
      return NextResponse.json({ ok: true });
    }

    // INSERT … ON CONFLICT so we both materialise default rows for
    // never-customised calendars and overwrite sort_order in one
    // statement. color/hidden are left at their defaults on insert and
    // unchanged on conflict — the user might have a custom color the
    // drag shouldn't disturb.
    const db = getDb();
    const stmts = resolved.map(r =>
      db
        .prepare(
          `INSERT INTO user_calendar_prefs (user_id, mailbox_id, sort_order)
             VALUES (?, ?, ?)
             ON CONFLICT(user_id, mailbox_id) DO UPDATE
                 SET sort_order = excluded.sort_order`,
        )
        .bind(user.id, r.mailboxId, r.sort_order),
    );
    await db.batch(stmts);

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("calendars reorder", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
