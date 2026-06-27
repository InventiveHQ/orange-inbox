import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { extractEventFromThread } from "@/lib/event-extract";

// POST /api/threads/[id]/event-suggestion
// Body: { now: "YYYY-MM-DDTHH:MM" (browser-local), tz: "<IANA zone>" }
// Returns an EventSuggestion the "Add to calendar" button uses to prefill the
// event composer. The browser supplies its own local time + zone so relative
// dates in the email resolve correctly without server-side timezone math.
interface Body {
  now?: string;
  tz?: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const b = (await req.json().catch(() => null)) as Body | null;
    const now =
      typeof b?.now === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.now)
        ? b.now
        : null;
    const tz = typeof b?.tz === "string" && b.tz ? b.tz : "UTC";
    if (!now) {
      return NextResponse.json({ error: "invalid_now" }, { status: 400 });
    }
    const suggestion = await extractEventFromThread(user.id, id, now, tz);
    return NextResponse.json(suggestion);
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
