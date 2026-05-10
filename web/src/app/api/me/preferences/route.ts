import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  getUserPreferences,
  updateUserPreferences,
  type PreferencesPatch,
} from "@/lib/preferences";

export async function GET() {
  try {
    const user = await requireUser();
    const prefs = await getUserPreferences(user.id);
    return NextResponse.json({ preferences: prefs });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as PreferencesPatch | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const next = await updateUserPreferences(user.id, body);
    if (!next) {
      return NextResponse.json({ error: "invalid_preferences" }, { status: 400 });
    }
    return NextResponse.json({ preferences: next });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
