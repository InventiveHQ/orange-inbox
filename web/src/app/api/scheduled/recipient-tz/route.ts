import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { inferRecipientTz } from "@/lib/recipient-tz";

// Best-effort TZ inference for the "9am in recipient's TZ" preset in the
// schedule-send menu. Lives next to /api/scheduled because it's only used
// by that flow.
//
// Auth is just "logged-in user" — the result reveals at most the median
// numeric offset of mail we've already received, which the user can already
// see by opening the original message.
export async function GET(req: NextRequest) {
  try {
    await requireUser();
    const email = req.nextUrl.searchParams.get("email")?.trim() ?? "";
    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }
    const inferred = await inferRecipientTz(email);
    if (!inferred) return NextResponse.json({ inferred: null });
    return NextResponse.json({
      inferred: {
        offset_minutes: inferred.offsetMinutes,
        sample_size: inferred.sampleSize,
      },
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
