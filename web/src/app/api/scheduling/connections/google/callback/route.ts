import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { exchangeGoogleCode } from "@/lib/google-calendar";
import { upsertCalendarConnection } from "@/lib/booking";

// GET /api/scheduling/connections/google/callback?code=&state=
//
// Completes the Google OAuth flow: verifies state, exchanges the code, and
// stores the connection with AES-GCM-encrypted tokens. Always redirects back
// to /scheduling with a status flag.

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  const back = (status: string) =>
    NextResponse.redirect(`${origin}/scheduling?google=${status}`);
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const cookieState = req.cookies.get("gcal_oauth_state")?.value;

    if (url.searchParams.get("error")) return back("denied");
    if (!code || !state || !cookieState || state !== cookieState) {
      return back("error");
    }

    const redirectUri = `${origin}/api/scheduling/connections/google/callback`;
    const tok = await exchangeGoogleCode(code, redirectUri);
    await upsertCalendarConnection({
      ownerUserId: user.id,
      accountEmail: tok.email,
      calendarId: "primary",
      displayName: tok.email,
      accessTokenEnc: await encryptSecret(tok.accessToken),
      refreshTokenEnc: tok.refreshToken
        ? await encryptSecret(tok.refreshToken)
        : null,
      tokenExpiresAt: tok.expiresAt,
    });

    const res = back("connected");
    res.cookies.delete("gcal_oauth_state");
    return res;
  } catch (e) {
    console.error("google oauth callback route", e);
    return back("error");
  }
}
