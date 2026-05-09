import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { insertSubscription } from "@/lib/push-subscriptions";

interface Body {
  subscription?: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
}

// Persist a Web Push subscription against the calling user. Re-subscribing
// the same endpoint refreshes the keys (push services rotate them).
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as Body | null;
    const endpoint = b?.subscription?.endpoint?.trim();
    const p256dh = b?.subscription?.keys?.p256dh;
    const auth = b?.subscription?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ error: "invalid_subscription" }, { status: 400 });
    }
    await insertSubscription({
      userId: user.id,
      endpoint,
      p256dh,
      authSecret: auth,
      userAgent: req.headers.get("user-agent")?.slice(0, 255) ?? null,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
