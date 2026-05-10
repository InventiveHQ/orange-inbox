import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  PERSONAL_CALENDAR,
  upsertCalendarPref,
  userHasMailboxAccess,
} from "@/lib/calendar";
import { getDb } from "@/lib/db";
import { listMailboxesForUser } from "@/lib/queries";

// /api/calendar/calendars (#78)
//
// GET — return every calendar the user has visibility into:
//         { calendars: [
//             { id: "personal", mailbox_id: null, name: "Personal",
//               color, hidden, sort_order, kind: "personal" },
//             { id: "<mailbox_id>", mailbox_id, name: "...", color,
//               hidden, sort_order, kind: "mailbox" },
//             ...
//         ] }
//       Each entry is the *resolved* row — defaults filled in for any
//       calendar the user hasn't customised yet. Rows are ordered by
//       sort_order ascending (#97); ties break alphabetically with
//       Personal pinned first when no rows have been reordered (the
//       legacy default-zero state).
//
// PATCH — body: { mailbox_id: string | null | "personal", color?, hidden?,
//                 sort_order? }
//         Upsert the prefs row for a single calendar. Mailbox access is
//         enforced. For bulk reorder use POST /reorder instead — that's
//         the path the drag-handler hits.

const DEFAULT_CALENDAR_COLOR = "#3b82f6";

interface CalendarSummary {
  // URL-safe id: "personal" or a mailbox id. Lets the client send a
  // single string back through ?mailbox= without a separate type field.
  id: string;
  mailbox_id: string | null;
  name: string;
  color: string;
  hidden: boolean;
  sort_order: number;
  kind: "personal" | "mailbox";
}

// Local read of user_calendar_prefs that includes sort_order. The shared
// listCalendarPrefs in @/lib/calendar predates #97 and only returns
// (mailbox_id, color, hidden); we need sort_order here to drive the
// sidebar order, so this route does its own SELECT rather than widening
// the lib helper (which is consumed by the form/event paths that don't
// care about ordering).
async function listCalendarPrefsWithOrder(
  userId: string,
): Promise<{ mailbox_id: string | null; color: string; hidden: number; sort_order: number }[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mailbox_id, color, hidden, sort_order
         FROM user_calendar_prefs
        WHERE user_id = ?`,
    )
    .bind(userId)
    .all<{ mailbox_id: string | null; color: string; hidden: number; sort_order: number }>();
  return results ?? [];
}

export async function GET() {
  try {
    const user = await requireUser();
    const [mailboxes, prefs] = await Promise.all([
      listMailboxesForUser(user.id),
      listCalendarPrefsWithOrder(user.id),
    ]);
    const prefByKey = new Map<string, { color: string; hidden: number; sort_order: number }>();
    for (const p of prefs) {
      prefByKey.set(p.mailbox_id ?? "", {
        color: p.color,
        hidden: p.hidden,
        sort_order: p.sort_order,
      });
    }

    const calendars: CalendarSummary[] = [];
    const personalPref = prefByKey.get("");
    calendars.push({
      id: PERSONAL_CALENDAR,
      mailbox_id: null,
      name: "Personal",
      color: personalPref?.color ?? DEFAULT_CALENDAR_COLOR,
      hidden: !!personalPref?.hidden,
      sort_order: personalPref?.sort_order ?? 0,
      kind: "personal",
    });
    for (const mb of mailboxes) {
      const pref = prefByKey.get(mb.id);
      calendars.push({
        id: mb.id,
        mailbox_id: mb.id,
        name: `${mb.local_part}@${mb.domain_name}`,
        color: pref?.color ?? DEFAULT_CALENDAR_COLOR,
        hidden: !!pref?.hidden,
        sort_order: pref?.sort_order ?? 0,
        kind: "mailbox",
      });
    }

    // Sort: explicit sort_order ascending (1..N from drag-reorder writes),
    // then alphabetical fallback for rows that still have sort_order = 0
    // (default state). Personal is pinned ahead of zero-sorted mailbox
    // rows by special-casing the kind, matching the pre-#97 default.
    calendars.sort((a, b) => {
      const ao = a.sort_order ?? 0;
      const bo = b.sort_order ?? 0;
      if (ao !== bo) {
        // 0 means "unordered, alphabetical tail" — push to the end.
        if (ao === 0) return 1;
        if (bo === 0) return -1;
        return ao - bo;
      }
      // Tie-break for sort_order = 0: Personal first, mailboxes alpha.
      if (ao === 0) {
        if (a.kind === "personal") return -1;
        if (b.kind === "personal") return 1;
      }
      return a.name.localeCompare(b.name);
    });
    return NextResponse.json({ calendars });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PatchBody {
  mailbox_id?: string | null;
  color?: string;
  hidden?: boolean;
  sort_order?: number;
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    // Resolve the calendar key. "personal" / null / undefined → Personal.
    const requestedMailbox =
      typeof b.mailbox_id === "string" && b.mailbox_id && b.mailbox_id !== PERSONAL_CALENDAR
        ? b.mailbox_id
        : null;
    if (requestedMailbox && !(await userHasMailboxAccess(user.id, requestedMailbox))) {
      return NextResponse.json(
        { error: "forbidden_mailbox", message: "no access to that mailbox" },
        { status: 403 },
      );
    }

    // Validate color if supplied. The sidebar's swatch grid uses Tailwind
    // hex literals, but the new "Custom..." picker (#97) lets users pick
    // any hex via <input type="color"> — so we still constrain to the
    // 7-char #RRGGBB shape but accept any value within it.
    let color: string | undefined;
    if (b.color !== undefined) {
      if (typeof b.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.color)) {
        return NextResponse.json({ error: "invalid_color" }, { status: 400 });
      }
      color = b.color.toLowerCase();
    }
    const hidden = b.hidden === undefined ? undefined : !!b.hidden;
    let sortOrder: number | undefined;
    if (b.sort_order !== undefined) {
      const v = Number(b.sort_order);
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        return NextResponse.json({ error: "invalid_sort_order" }, { status: 400 });
      }
      sortOrder = v;
    }
    if (color === undefined && hidden === undefined && sortOrder === undefined) {
      return NextResponse.json(
        { error: "no_changes", message: "supply color, hidden, or sort_order" },
        { status: 400 },
      );
    }

    // upsertCalendarPref handles color/hidden via the shared helper; the
    // sort_order column is new on this table (#97 / migration 0047) and
    // not yet plumbed through the helper, so we do a focused UPDATE for
    // the order field and let upsertCalendarPref handle the rest.
    if (color !== undefined || hidden !== undefined) {
      await upsertCalendarPref(user.id, {
        mailboxId: requestedMailbox,
        color,
        hidden,
      });
    }
    if (sortOrder !== undefined) {
      // Materialise a row first if the user is sort_order-only-touching a
      // calendar they've never customised — upsertCalendarPref with no
      // patch fields produces a default row with color/hidden defaults.
      if (color === undefined && hidden === undefined) {
        await upsertCalendarPref(user.id, { mailboxId: requestedMailbox });
      }
      await getDb()
        .prepare(
          `UPDATE user_calendar_prefs
              SET sort_order = ?
            WHERE user_id = ?
              AND ${requestedMailbox === null ? "mailbox_id IS NULL" : "mailbox_id = ?"}`,
        )
        .bind(
          ...(requestedMailbox === null
            ? [sortOrder, user.id]
            : [sortOrder, user.id, requestedMailbox]),
        )
        .run();
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error("calendar calendars route", e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
