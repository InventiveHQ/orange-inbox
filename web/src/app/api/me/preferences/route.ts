import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  getUserPreferences,
  updateUserPreferences,
  updateWeekStartDay,
  type PreferencesPatch,
} from "@/lib/preferences";

export async function GET() {
  try {
    const user = await requireUser();
    const prefs = await getUserPreferences(user.id);
    return NextResponse.json({
      preferences: prefs,
      // week_start_day lives on the users row (0046) rather than
      // user_preferences. Surfaced here so the calendar grid has both
      // pref shapes available off a single fetch.
      week_start_day: user.week_start_day,
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}

interface ExtendedPatch extends PreferencesPatch {
  week_start_day?: number;
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as ExtendedPatch | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    // Pull week_start_day out of the patch before forwarding the rest to
    // user_preferences — it's stored on the users row, not the prefs blob.
    let nextWeekStart = user.week_start_day;
    if (body.week_start_day !== undefined) {
      const ok = await updateWeekStartDay(user.id, body.week_start_day);
      if (!ok) {
        return NextResponse.json(
          { error: "invalid_week_start_day" },
          { status: 400 },
        );
      }
      nextWeekStart = body.week_start_day;
    }
    const prefsPatch: PreferencesPatch = {
      theme: body.theme,
      accent_hex: body.accent_hex,
      density: body.density,
      default_track_opens: body.default_track_opens,
      auto_archive_marketing: body.auto_archive_marketing,
    };
    const next = await updateUserPreferences(user.id, prefsPatch);
    if (!next) {
      return NextResponse.json({ error: "invalid_preferences" }, { status: 400 });
    }
    return NextResponse.json({ preferences: next, week_start_day: nextWeekStart });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
