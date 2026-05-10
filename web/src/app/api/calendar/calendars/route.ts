import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  PERSONAL_CALENDAR,
  listCalendarPrefs,
  upsertCalendarPref,
  userHasMailboxAccess,
} from "@/lib/calendar";
import { listMailboxesForUser } from "@/lib/queries";

// /api/calendar/calendars (#78)
//
// GET — return every calendar the user has visibility into:
//         { calendars: [
//             { id: "personal", mailbox_id: null, name: "Personal",
//               color, hidden, kind: "personal" },
//             { id: "<mailbox_id>", mailbox_id, name: "...", color,
//               hidden, kind: "mailbox" },
//             ...
//         ] }
//       Each entry is the *resolved* row — defaults filled in for any
//       calendar the user hasn't customised yet.
//
// PATCH — body: { mailbox_id: string | null | "personal", color?, hidden? }
//         Upsert the prefs row. Mailbox access is enforced.

const DEFAULT_CALENDAR_COLOR = "#3b82f6";

interface CalendarSummary {
  // URL-safe id: "personal" or a mailbox id. Lets the client send a
  // single string back through ?mailbox= without a separate type field.
  id: string;
  mailbox_id: string | null;
  name: string;
  color: string;
  hidden: boolean;
  kind: "personal" | "mailbox";
}

export async function GET() {
  try {
    const user = await requireUser();
    const [mailboxes, prefs] = await Promise.all([
      listMailboxesForUser(user.id),
      listCalendarPrefs(user.id),
    ]);
    // Index prefs by mailbox_id (NULL for Personal) so we can hand each
    // calendar its row in O(1). NULL keys live under the empty string —
    // mailboxes never have an empty id so the namespace doesn't collide.
    const prefByKey = new Map<string, { color: string; hidden: number }>();
    for (const p of prefs) {
      prefByKey.set(p.mailbox_id ?? "", { color: p.color, hidden: p.hidden });
    }

    const calendars: CalendarSummary[] = [];
    // Personal first — keeps the sidebar order stable across users.
    const personalPref = prefByKey.get("");
    calendars.push({
      id: PERSONAL_CALENDAR,
      mailbox_id: null,
      name: "Personal",
      color: personalPref?.color ?? DEFAULT_CALENDAR_COLOR,
      hidden: !!personalPref?.hidden,
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
        kind: "mailbox",
      });
    }
    return NextResponse.json({ calendars });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PatchBody {
  mailbox_id?: string | null;
  color?: string;
  hidden?: boolean;
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

    // Validate color if supplied — the swatch picker is constrained client
    // side but we don't trust the client. Tailwind palette values are all
    // 7-char hex literals.
    let color: string | undefined;
    if (b.color !== undefined) {
      if (typeof b.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.color)) {
        return NextResponse.json({ error: "invalid_color" }, { status: 400 });
      }
      color = b.color.toLowerCase();
    }
    const hidden = b.hidden === undefined ? undefined : !!b.hidden;
    if (color === undefined && hidden === undefined) {
      return NextResponse.json(
        { error: "no_changes", message: "supply color or hidden" },
        { status: 400 },
      );
    }

    await upsertCalendarPref(user.id, {
      mailboxId: requestedMailbox,
      color,
      hidden,
    });
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
