import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getEnv } from "@/lib/db";

// Returns the server's VAPID public key so the browser can call
// pushManager.subscribe({applicationServerKey}). Public key is safe to
// expose; it's also embedded in wrangler.jsonc vars.
export async function GET() {
  try {
    await requireUser();
    const env = getEnv() as unknown as { VAPID_PUBLIC_KEY?: string };
    if (!env.VAPID_PUBLIC_KEY) {
      return NextResponse.json({ error: "vapid_not_configured" }, { status: 500 });
    }
    return NextResponse.json({ publicKey: env.VAPID_PUBLIC_KEY });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
