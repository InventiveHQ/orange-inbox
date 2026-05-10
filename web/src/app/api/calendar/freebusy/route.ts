import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  getBusyWindowsForUser,
  getMailboxBusyWindows,
  userHasMailboxAccess,
} from "@/lib/calendar";

// Free/busy aggregation (#86).
//
//   GET /api/calendar/freebusy?from=<unix>&to=<unix>[&mailbox=<id>][&exclude=<event_id>]
//
// Two modes:
//   - `mailbox` set    → busy windows across every user with access to
//                        that mailbox. Caller must also have access.
//   - `mailbox` unset  → caller's own busy windows only. Used by the
//                        in-form conflict banner.
//
// `exclude` skips the event being edited so re-saving doesn't conflict
// with itself. Optional; only honoured in the self-only mode.
//
// CRITICAL: response shape is `{ busy: [{ start, end }] }` — no titles,
// no attendees, no descriptions, no source attribution. The free/busy
// surface is permission-checked but the cells themselves never leak
// content. (#86 explicitly calls this out.)

const MAX_RANGE_SECONDS = 366 * 24 * 60 * 60 * 2;

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");
    if (!fromRaw || !toRaw) {
      return NextResponse.json(
        { error: "missing_range", message: "from and to (unix seconds) are required" },
        { status: 400 },
      );
    }
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return NextResponse.json({ error: "invalid_range" }, { status: 400 });
    }
    if (to - from > MAX_RANGE_SECONDS) {
      return NextResponse.json({ error: "range_too_wide" }, { status: 400 });
    }

    const mailboxId = url.searchParams.get("mailbox");
    const exclude = url.searchParams.get("exclude");

    if (mailboxId) {
      // Cross-user mode. Caller must have access (otherwise this would
      // become a "scan any mailbox's busy state" endpoint). The query
      // itself further filters by user_calendar_prefs.hidden so a
      // contributor who's hidden the calendar isn't surfaced — see
      // getMailboxBusyWindows.
      const allowed = await userHasMailboxAccess(user.id, mailboxId);
      if (!allowed) {
        return NextResponse.json(
          { error: "forbidden_mailbox", message: "no access to that mailbox" },
          { status: 403 },
        );
      }
      const busy = await getMailboxBusyWindows(mailboxId, from, to);
      return NextResponse.json({ busy });
    }

    const busy = await getBusyWindowsForUser(user.id, from, to, exclude);
    return NextResponse.json({ busy });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("freebusy route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
