import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getUserDefaultTz, setUserDefaultTz } from "@/lib/calendar";

export async function GET() {
  try {
    const user = await requireUser();
    // default_tz lives on users.default_tz (#82) but isn't on the User
    // shape returned by requireUser — that interface is shared with
    // every other route and stays minimal. The CalendarEventForm reads
    // it from the top-level `default_tz` field as a fallback (see
    // CalendarEventForm.tsx — `j.user?.default_tz ?? j.default_tz`),
    // and SettingsManager reads the same key.
    const default_tz = await getUserDefaultTz(user.id);
    return NextResponse.json({ user, default_tz });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}

// Allowed Undo Send delays. 0 disables the feature; the rest mirror Gmail.
const UNDO_SEND_OPTIONS = [0, 5, 10, 20, 30] as const;

interface PatchBody {
  undo_send_seconds?: number;
  // IANA zone string ("America/Los_Angeles") or null to clear back to
  // device-tz fallback. Validated via Intl.DateTimeFormat on the server
  // — invalid values throw and we 400.
  default_tz?: string | null;
}

// Validate that `tz` parses as a real IANA zone before storing. The Intl
// constructor throws RangeError on unknown zones; we catch and return
// false. Empty / null short-circuits as "clear the value".
function isValidIanaTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    if (b.undo_send_seconds !== undefined) {
      const v = Number(b.undo_send_seconds);
      if (!UNDO_SEND_OPTIONS.includes(v as (typeof UNDO_SEND_OPTIONS)[number])) {
        return NextResponse.json({ error: "invalid_undo_send_seconds" }, { status: 400 });
      }
      await getDb()
        .prepare("UPDATE users SET undo_send_seconds = ? WHERE id = ?")
        .bind(v, user.id)
        .run();
    }

    if (b.default_tz !== undefined) {
      // null / empty string both clear the pref so legacy users fall back
      // to device tz. A non-empty string must parse as a real IANA zone.
      if (b.default_tz === null || b.default_tz === "") {
        await setUserDefaultTz(user.id, null);
      } else if (typeof b.default_tz === "string" && isValidIanaTz(b.default_tz)) {
        await setUserDefaultTz(user.id, b.default_tz);
      } else {
        return NextResponse.json({ error: "invalid_default_tz" }, { status: 400 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
