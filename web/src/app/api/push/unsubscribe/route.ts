import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { deleteSubscriptionByEndpoint } from "@/lib/push-subscriptions";

interface Body {
  endpoint?: string;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as Body | null;
    const endpoint = b?.endpoint?.trim();
    if (!endpoint) {
      return NextResponse.json({ error: "endpoint_required" }, { status: 400 });
    }
    await deleteSubscriptionByEndpoint(user.id, endpoint);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
