import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { randomToken } from "@/lib/crypto";
import { buildGoogleAuthUrl, googleConfigured } from "@/lib/google-calendar";

// GET /api/scheduling/connections/google/start
//
// Begins the Google OAuth flow. A random `state` is stored in a short-lived
// httpOnly cookie and verified on callback (CSRF protection).

export async function GET(req: NextRequest) {
  try {
    await requireUser();
    if (!googleConfigured()) {
      return NextResponse.json(
        {
          error: "google_not_configured",
          message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.",
        },
        { status: 400 },
      );
    }
    const origin = new URL(req.url).origin;
    const redirectUri = `${origin}/api/scheduling/connections/google/callback`;
    const state = randomToken(24);
    const res = NextResponse.redirect(buildGoogleAuthUrl(redirectUri, state));
    res.cookies.set("gcal_oauth_state", state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return res;
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("google oauth start route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
