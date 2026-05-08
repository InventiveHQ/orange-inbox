import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getStorageStats } from "@/lib/mail-db";

// Capacity stats for the sidebar progress bar. No admin gate today — every
// signed-in user sees the same view of mail-DB pressure, since "we're about
// to stop accepting your mail" is something they'd want to know either way.
export async function GET() {
  try {
    await requireUser();
    const stats = await getStorageStats();
    return NextResponse.json(stats);
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
